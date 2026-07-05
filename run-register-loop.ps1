<#
.SYNOPSIS
  原生 PowerShell 调度器：按随机间隔执行 `npm run register`（Stage A 注册 + session 持久化）。
  支持串行（默认）与并发（-Concurrency N，每 worker 独立 profile 目录）。

.DESCRIPTION
  常驻循环，不依赖 Windows 任务计划程序（其随机延迟做不到秒级）。
    串行 (-Concurrency 1)：执行 → 记录退出码/耗时 → 随机 sleep(Min..Max) → 下一轮。
    并发 (-Concurrency N)：每隔随机 sleep 投放一个 worker，同时在跑不超过 N 个；
                           每个 worker 用独立 CHROME_PROFILE_DIR=.chrome-profile-w<slot> 避免撞车。
  单实例锁防止误开第二个调度器。Ctrl+C 可干净退出并释放锁（并发模式会等在跑的 worker 收尾）。

.PARAMETER MinSeconds
  投放间隔最小秒数（默认 110）。

.PARAMETER MaxSeconds
  投放间隔最大秒数（默认 600，含）。

.PARAMETER MaxRuns
  最多投放的 worker 总数；0 = 无限直到 Ctrl+C（默认 0）。

.PARAMETER Concurrency
  同时在跑的 worker 上限（默认 1 = 串行）。>1 时每个 worker 分配独立 profile 目录。

.PARAMETER ProjectDir
  package.json 所在目录（默认脚本自身所在目录）。

.PARAMETER LogFile
  主日志追加文件（默认 <ProjectDir>\logs\register-loop.log）。并发模式下每个 worker 另有
  <ProjectDir>\logs\worker-w<slot>-<seq>.log。

.PARAMETER FirstDelaySeconds
  首次投放前的等待秒数（默认 0）。

.PARAMETER Headless
  开关：传入则设 HEADLESS=true 无头运行；不传维持项目默认（有头）。

.EXAMPLE
  .\run-register-loop.ps1
  # 串行，110-600 秒随机间隔，无限循环

.EXAMPLE
  .\run-register-loop.ps1 -Concurrency 3 -Headless
  # 3 个并发 worker（各自独立 profile），无头

.EXAMPLE
  .\run-register-loop.ps1 -Concurrency 5 -MaxRuns 50 -MinSeconds 30 -MaxSeconds 90
  # 最多 5 并发，共投放 50 个，每 30-90 秒投放一个

.EXAMPLE
  Start-Process powershell -ArgumentList '-NoProfile','-File','.\run-register-loop.ps1','-Concurrency','3' -WindowStyle Hidden
  # 后台静默并发运行
#>
[CmdletBinding()]
param(
    [int]$MinSeconds = 110,
    [int]$MaxSeconds = 600,
    [int]$MaxRuns = 0,
    [int]$Concurrency = 1,
    [string]$ProjectDir = $PSScriptRoot,
    [string]$LogFile = "",
    [int]$FirstDelaySeconds = 0,
    [switch]$Headless
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($MinSeconds -lt 1) { throw "MinSeconds 必须 >= 1" }
if ($MaxSeconds -lt $MinSeconds) { throw "MaxSeconds ($MaxSeconds) 不能小于 MinSeconds ($MinSeconds)" }
if ($Concurrency -lt 1) { throw "Concurrency 必须 >= 1" }
if (-not (Test-Path (Join-Path $ProjectDir 'package.json'))) {
    throw "在 $ProjectDir 找不到 package.json——请用 -ProjectDir 指定 github-register 目录"
}

if ([string]::IsNullOrWhiteSpace($LogFile)) {
    $LogFile = Join-Path $ProjectDir 'logs\register-loop.log'
}
$logDir = Split-Path -Parent $LogFile
if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] [$Level] $Message"
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# 投放一个 worker 进程（Start-Process，输出重定向到 worker 日志）。返回 process 对象。
function Start-Worker {
    param([int]$Slot, [int]$Seq)
    $profileDir = Join-Path $ProjectDir ".chrome-profile-w$Slot"
    $workerLog = Join-Path $logDir "worker-w$Slot-$Seq.log"
    # 独立 profile 目录避免 Chrome ProcessSingleton 撞车。
    $env:CHROME_PROFILE_DIR = $profileDir
    if ($Headless) { $env:HEADLESS = 'true' }
    # npm.cmd 通过 cmd /c 拉起，stdout/stderr 合并到 worker 日志。
    $p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'register' `
        -WorkingDirectory $ProjectDir -PassThru -NoNewWindow `
        -RedirectStandardOutput $workerLog -RedirectStandardError "$workerLog.err"
    return $p
}

# ── 单实例锁：同一 ProjectDir 只允许一个调度器 ──────────────
$lockFile = Join-Path $ProjectDir 'logs\register-loop.lock'
if (Test-Path $lockFile) {
    $existingPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $alive = $false
    if ($existingPid -match '^\d+$') {
        $alive = [bool](Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue)
    }
    if ($alive) {
        throw "已有调度器在运行 (PID $existingPid)。若确认是残留，删除 $lockFile 后重试。"
    } else {
        Write-Log "发现残留锁 (PID $existingPid 已退出)，接管。" 'WARN'
    }
}

$launched = 0        # 已投放 worker 总数
$successCount = 0
$failCount = 0
$startedAll = Get-Date
$running = @{}        # slot(int) -> @{ Proc; Seq; StartedAt }

try {
    Set-Content -Path $lockFile -Value $PID -Encoding ASCII

    Write-Log "═══ register 调度器启动 ═══"
    Write-Log "项目目录: $ProjectDir"
    Write-Log ("间隔: {0}-{1}s随机 | 并发: {2} | 上限: {3} | 模式: {4} | PID {5}" -f `
        $MinSeconds, $MaxSeconds, $Concurrency, `
        $(if ($MaxRuns -eq 0) { '无限' } else { $MaxRuns }), `
        $(if ($Headless) { '无头' } else { '有头' }), $PID)
    Write-Log "日志: $LogFile"

    if ($FirstDelaySeconds -gt 0) {
        Write-Log "首次投放前等待 $FirstDelaySeconds 秒..."
        Start-Sleep -Seconds $FirstDelaySeconds
    }

    # 回收已结束的 worker，更新计数。返回回收数量。
    function Reap-Finished {
        $done = @()
        foreach ($slot in @($running.Keys)) {
            $w = $running[$slot]
            if ($w.Proc.HasExited) {
                $rc = $w.Proc.ExitCode
                $took = [math]::Round(((Get-Date) - $w.StartedAt).TotalSeconds, 1)
                if ($rc -eq 0) {
                    $script:successCount++
                    Write-Log ("worker#{0} (slot{1}) 成功 ({2}s, exit=0) | 累计 成功 {3} / 失败 {4} | 在跑 {5}" -f `
                        $w.Seq, $slot, $took, $script:successCount, $script:failCount, ($running.Count - 1)) 'OK'
                } else {
                    $script:failCount++
                    Write-Log ("worker#{0} (slot{1}) 失败 ({2}s, exit={3}) | 累计 成功 {4} / 失败 {5} | 在跑 {6}" -f `
                        $w.Seq, $slot, $took, $rc, $script:successCount, $script:failCount, ($running.Count - 1)) 'ERROR'
                }
                $done += $slot
            }
        }
        foreach ($slot in $done) { $running.Remove($slot) }
        return $done.Count
    }

    # 找一个空闲 slot 号（1..Concurrency）。
    function Get-FreeSlot {
        for ($s = 1; $s -le $Concurrency; $s++) {
            if (-not $running.ContainsKey($s)) { return $s }
        }
        return -1
    }

    while ($true) {
        Reap-Finished | Out-Null

        $canLaunchMore = ($MaxRuns -eq 0 -or $launched -lt $MaxRuns)
        $hasFreeSlot = ($running.Count -lt $Concurrency)

        if ($canLaunchMore -and $hasFreeSlot) {
            $slot = Get-FreeSlot
            $launched++
            $seq = $launched
            Write-Log ("投放 worker#{0} → slot{1} (profile .chrome-profile-w{1}) | 在跑 {2}/{3}" -f `
                $seq, $slot, ($running.Count + 1), $Concurrency)
            $proc = Start-Worker -Slot $slot -Seq $seq
            $running[$slot] = @{ Proc = $proc; Seq = $seq; StartedAt = (Get-Date) }

            # 投放节奏：随机间隔后再考虑下一个（Maximum 排他，+1 含上界）。
            $sleepSec = Get-Random -Minimum $MinSeconds -Maximum ($MaxSeconds + 1)
            $nextAt = (Get-Date).AddSeconds($sleepSec).ToString('HH:mm:ss')
            Write-Log "下次投放在 $sleepSec 秒后 (~$nextAt)"
            Start-Sleep -Seconds $sleepSec
        }
        elseif (-not $canLaunchMore -and $running.Count -eq 0) {
            break   # 投满且无在跑 → 结束
        }
        else {
            # slot 满或已投满但仍有在跑 → 短轮询等待回收。
            Start-Sleep -Seconds 3
        }
    }

    Write-Log "达到投放上限 MaxRuns=$MaxRuns，全部 worker 已收尾。" 'WARN'
}
finally {
    # Ctrl+C 或异常：等仍在跑的 worker 收尾（最多等 5 分钟），再释放锁。
    if ($running.Count -gt 0) {
        Write-Log "等待 $($running.Count) 个在跑 worker 收尾..." 'WARN'
        $deadline = (Get-Date).AddMinutes(5)
        while ($running.Count -gt 0 -and (Get-Date) -lt $deadline) {
            foreach ($slot in @($running.Keys)) {
                if ($running[$slot].Proc.HasExited) { $running.Remove($slot) }
            }
            if ($running.Count -gt 0) { Start-Sleep -Seconds 3 }
        }
    }
    $elapsed = [math]::Round(((Get-Date) - $startedAll).TotalMinutes, 1)
    Write-Log ("═══ 调度器退出 | 投放 {0} (成功 {1} / 失败 {2}) | 运行 {3} 分钟 ═══" -f `
        $launched, $successCount, $failCount, $elapsed) 'WARN'
    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}
