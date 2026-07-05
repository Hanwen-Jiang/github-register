#!/bin/bash
# run-register-loop.sh — mac/Linux 常驻调度器：按随机间隔执行 `npm run register`
#   (Stage A 注册 + session 持久化)。run-register-loop.ps1 的 bash 等价物。
#
# 支持串行（默认）与并发（--concurrency N，每 worker 独立 profile 目录）。
#   串行 (--concurrency 1)：执行 → 记录退出码/耗时 → 随机 sleep(min..max) → 下一轮。
#   并发 (--concurrency N)：每隔随机 sleep 投放一个 worker，同时在跑不超过 N 个；
#                          每个 worker 用独立 CHROME_PROFILE_DIR=.chrome-profile-w<slot> 避免撞车。
# 单实例锁防止误开第二个调度器。Ctrl+C / SIGTERM 干净退出并释放锁（等在跑 worker 收尾，最多 5 分钟）。
#
# 用法:
#   ./run-register-loop.sh                       # 串行，110-600s 随机间隔，无限循环，有头
#   ./run-register-loop.sh --headless            # 同上，无头
#   ./run-register-loop.sh --concurrency 3 --headless
#   ./run-register-loop.sh --concurrency 5 --max-runs 50 --min-seconds 30 --max-seconds 90
#
# 参数:
#   --min-seconds N       投放间隔最小秒数（默认 110）
#   --max-seconds N       投放间隔最大秒数（含，默认 600）
#   --max-runs N          最多投放 worker 总数；0 = 无限直到 Ctrl+C（默认 0）
#   --concurrency N       同时在跑 worker 上限（默认 1 = 串行）
#   --project-dir DIR     package.json 所在目录（默认脚本所在目录）
#   --log-file FILE       主日志追加文件（默认 <project-dir>/logs/register-loop.log）
#   --first-delay N       首次投放前等待秒数（默认 0）
#   --headless            设 HEADLESS=true 无头运行；不传维持项目默认（有头）

set -u

MIN_SECONDS=110
MAX_SECONDS=600
MAX_RUNS=0
CONCURRENCY=1
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE=""
FIRST_DELAY=0
HEADLESS=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --min-seconds) MIN_SECONDS="$2"; shift 2 ;;
        --max-seconds) MAX_SECONDS="$2"; shift 2 ;;
        --max-runs) MAX_RUNS="$2"; shift 2 ;;
        --concurrency) CONCURRENCY="$2"; shift 2 ;;
        --project-dir) PROJECT_DIR="$2"; shift 2 ;;
        --log-file) LOG_FILE="$2"; shift 2 ;;
        --first-delay) FIRST_DELAY="$2"; shift 2 ;;
        --headless) HEADLESS=1; shift ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

(( MIN_SECONDS >= 1 )) || { echo "min-seconds 必须 >= 1" >&2; exit 1; }
(( MAX_SECONDS >= MIN_SECONDS )) || { echo "max-seconds ($MAX_SECONDS) 不能小于 min-seconds ($MIN_SECONDS)" >&2; exit 1; }
(( CONCURRENCY >= 1 )) || { echo "concurrency 必须 >= 1" >&2; exit 1; }
[[ -f "$PROJECT_DIR/package.json" ]] || { echo "在 $PROJECT_DIR 找不到 package.json——请用 --project-dir 指定 github-register 目录" >&2; exit 1; }

LOG_DIR="$PROJECT_DIR/logs"
[[ -n "$LOG_FILE" ]] || LOG_FILE="$LOG_DIR/register-loop.log"
LOG_DIR="$(dirname "$LOG_FILE")"
mkdir -p "$LOG_DIR"

log() {
    local level="${2:-INFO}"
    local ts line
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    line="[$ts] [$level] $1"
    echo "$line"
    echo "$line" >> "$LOG_FILE"
}

# 投放一个 worker（后台 npm run register），stdout/stderr 分别落到 worker 日志。回显 PID。
start_worker() {
    local slot="$1" seq="$2"
    local profile_dir="$PROJECT_DIR/.chrome-profile-w$slot"
    local worker_log="$LOG_DIR/worker-w$slot-$seq.log"
    # --headless 时导出 HEADLESS=true；否则不传，index.js 维持项目默认（有头）。
    if (( HEADLESS == 1 )); then
        CHROME_PROFILE_DIR="$profile_dir" HEADLESS="true" \
            npm --prefix "$PROJECT_DIR" run register \
            >"$worker_log" 2>"$worker_log.err" &
    else
        CHROME_PROFILE_DIR="$profile_dir" \
            npm --prefix "$PROJECT_DIR" run register \
            >"$worker_log" 2>"$worker_log.err" &
    fi
    echo $!
}

# ── 单实例锁：同一 project-dir 只允许一个调度器 ──────────────
LOCK_FILE="$LOG_DIR/register-loop.lock"
if [[ -f "$LOCK_FILE" ]]; then
    existing_pid="$(head -n1 "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
        echo "已有调度器在运行 (PID $existing_pid)。若确认是残留，删除 $LOCK_FILE 后重试。" >&2
        exit 1
    else
        log "发现残留锁 (PID $existing_pid 已退出)，接管。" WARN
    fi
fi
echo "$$" > "$LOCK_FILE"

LAUNCHED=0
SUCCESS_COUNT=0
FAIL_COUNT=0
STARTED_ALL=$(date +%s)
# 并行数组：RUN_PID[slot] / RUN_SEQ[slot] / RUN_START[slot]
declare -a RUN_PID RUN_SEQ RUN_START
STOPPING=0

on_signal() { STOPPING=1; log "收到停止信号，准备收尾..." WARN; }
trap on_signal INT TERM

cleanup() {
    # 等仍在跑的 worker 收尾（最多 5 分钟），再释放锁。
    local remaining deadline slot pid
    remaining=0
    for slot in "${!RUN_PID[@]}"; do remaining=$((remaining + 1)); done
    if (( remaining > 0 )); then
        log "等待 $remaining 个在跑 worker 收尾..." WARN
        deadline=$(( $(date +%s) + 300 ))
        while (( $(date +%s) < deadline )); do
            for slot in "${!RUN_PID[@]}"; do
                pid="${RUN_PID[$slot]}"
                kill -0 "$pid" 2>/dev/null || unset 'RUN_PID[$slot]'
            done
            (( ${#RUN_PID[@]} == 0 )) && break
            sleep 3
        done
    fi
    local elapsed_min
    elapsed_min=$(awk "BEGIN{printf \"%.1f\", ($(date +%s) - $STARTED_ALL)/60}")
    log "═══ 调度器退出 | 投放 $LAUNCHED (成功 $SUCCESS_COUNT / 失败 $FAIL_COUNT) | 运行 ${elapsed_min} 分钟 ═══" WARN
    rm -f "$LOCK_FILE"
}
trap cleanup EXIT

log "═══ register 调度器启动 ═══"
log "项目目录: $PROJECT_DIR"
[[ $MAX_RUNS -eq 0 ]] && runs_label="无限" || runs_label="$MAX_RUNS"
[[ $HEADLESS -eq 1 ]] && mode_label="无头" || mode_label="有头"
log "间隔: ${MIN_SECONDS}-${MAX_SECONDS}s随机 | 并发: $CONCURRENCY | 上限: $runs_label | 模式: $mode_label | PID $$"
log "日志: $LOG_FILE"

if (( FIRST_DELAY > 0 )); then
    log "首次投放前等待 $FIRST_DELAY 秒..."
    sleep "$FIRST_DELAY"
fi

# 回收已结束的 worker，更新计数。
reap_finished() {
    local slot pid rc took now
    now=$(date +%s)
    for slot in "${!RUN_PID[@]}"; do
        pid="${RUN_PID[$slot]}"
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" 2>/dev/null
            rc=$?
            took=$(( now - RUN_START[slot] ))
            if (( rc == 0 )); then
                SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
                log "worker#${RUN_SEQ[$slot]} (slot$slot) 成功 (${took}s, exit=0) | 累计 成功 $SUCCESS_COUNT / 失败 $FAIL_COUNT | 在跑 $(( ${#RUN_PID[@]} - 1 ))" OK
            else
                FAIL_COUNT=$((FAIL_COUNT + 1))
                log "worker#${RUN_SEQ[$slot]} (slot$slot) 失败 (${took}s, exit=$rc) | 累计 成功 $SUCCESS_COUNT / 失败 $FAIL_COUNT | 在跑 $(( ${#RUN_PID[@]} - 1 ))" ERROR
            fi
            unset 'RUN_PID[$slot]' 'RUN_SEQ[$slot]' 'RUN_START[$slot]'
        fi
    done
}

# 找一个空闲 slot 号（1..CONCURRENCY）。回显 slot 或 -1。
get_free_slot() {
    local s
    for (( s = 1; s <= CONCURRENCY; s++ )); do
        [[ -z "${RUN_PID[$s]:-}" ]] && { echo "$s"; return; }
    done
    echo "-1"
}

while true; do
    reap_finished

    if (( STOPPING == 1 )); then
        (( ${#RUN_PID[@]} == 0 )) && break
        sleep 3
        continue
    fi

    can_launch_more=0
    (( MAX_RUNS == 0 || LAUNCHED < MAX_RUNS )) && can_launch_more=1
    has_free_slot=0
    (( ${#RUN_PID[@]} < CONCURRENCY )) && has_free_slot=1

    if (( can_launch_more == 1 && has_free_slot == 1 )); then
        slot=$(get_free_slot)
        LAUNCHED=$((LAUNCHED + 1))
        seq=$LAUNCHED
        log "投放 worker#$seq → slot$slot (profile .chrome-profile-w$slot) | 在跑 $(( ${#RUN_PID[@]} + 1 ))/$CONCURRENCY"
        pid=$(start_worker "$slot" "$seq")
        RUN_PID[$slot]=$pid
        RUN_SEQ[$slot]=$seq
        RUN_START[$slot]=$(date +%s)

        # 投放节奏：随机间隔后再考虑下一个（含上界）。
        sleep_sec=$(( RANDOM % (MAX_SECONDS - MIN_SECONDS + 1) + MIN_SECONDS ))
        next_at=$(date -v+"${sleep_sec}"S '+%H:%M:%S' 2>/dev/null || date -d "+${sleep_sec} seconds" '+%H:%M:%S' 2>/dev/null || echo "?")
        log "下次投放在 $sleep_sec 秒后 (~$next_at)"
        # 分段 sleep（每段最多 3s），便于及时响应停止信号与回收在跑 worker。
        waited=0
        while (( waited < sleep_sec )); do
            (( STOPPING == 1 )) && break
            chunk=$(( sleep_sec - waited ))
            (( chunk > 3 )) && chunk=3
            sleep "$chunk"
            waited=$(( waited + chunk ))
            reap_finished
        done
    elif (( can_launch_more == 0 && ${#RUN_PID[@]} == 0 )); then
        log "达到投放上限 max-runs=${MAX_RUNS}，全部 worker 已收尾。" WARN
        break
    else
        sleep 3
    fi
done
