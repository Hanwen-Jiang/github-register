# GitHub 注册 / OAuth 运行手册

三种运行方式：**① 纯注册（Stage A）**、**② 纯 OAuth（Stage B）**、**③ 注册+OAuth 一条龙**。
工作目录：`E:\jhw\reg\github-register`（所有命令在此目录执行）。

---

## 架构（解耦后）

```
① gh reg           register-github.js   注册 GitHub → 存 session（data/sessions.jsonl），不 OAuth
② oauth            oauth-site.js        读 session → OAuth 引导站 → 建 key → 写 results.jsonl
③ gh reg + oauth   index.js (main)      ①+② 一条龙（注册完直接用内存里的 cookie 走 OAuth）
```

- **session 库**：`data/sessions.jsonl`（每行一个账号：email/username/password/proxy/storageState/已注册站/状态）
- **结果库**：`data/results.jsonl`（每行含 keys，格式与历史一致）
- session 是「先导」：一个 GitHub 账号存下来后，可被 ② 反复驱动去 OAuth 任意新引导站。

---

## 前置要求（三种方式通用）

`.env` 需配好：

| 键 | 说明 |
|---|---|
| `MAILOPS_API_TOKEN` | Mailops OTP 查询（收 GitHub 验证码，必需） |
| `DEFAULT_PASSWORD` | GitHub 账号密码（必需） |
| `EMAIL_DOMAINS` | 邮箱域名池（逗号分隔，生成时随机选；已配 16 个） |
| `PROXY_LIST` | 代理池（逗号分隔，随机选一个；连不上自动换/直连） |
| `CAPTCHA_API_KEY` / `CAPTCHA_SOLVER` | GitHub 注册验证码求解（① ③ 需要，② 不需要） |

依赖：`npm install` + `npx playwright install chromium`（① ③ 要浏览器；② 纯 HTTP 不需要浏览器）。

---

## ① 纯注册（Stage A）

只注册 GitHub 账号并把 session 存进 `sessions.jsonl`，**不做 OAuth**。

```bash
npm run register                              # 随机身份 + 随机域名 + 随机代理
SIGNUP_EMAIL=alice@han-wen.top npm run register   # 指定邮箱（域名须在 EMAIL_DOMAINS 白名单内）
HEADLESS=true npm run register                # 无头
```

产出：`sessions.jsonl` 新增一行，`empty_keys:true`（还没 OAuth 出 key）。
用途：先囤一批 GitHub session，之后用 ② 分批消费到各引导站。

---

## ② 纯 OAuth（Stage B）

从 `sessions.jsonl` 取已存的 session，去 OAuth 引导站建 key。**站点无关**，支持未来新站（改 `lib/sites.js` 加站即可）。**不需要浏览器**（纯 HTTP）。

```bash
# 自动挑一个可复用 session，OAuth 到指定站
SITE_LIST=cun.ai npm run oauth:site
SITE_LIST=a6api  npm run oauth:site

# 指定账号 / 指定站（--site 覆盖 SITE_LIST）
node oauth-site.js --email alice@han-wen.top --site a6api
node oauth-site.js --email alice@han-wen.top          # 该账号 OAuth 所有目标站
```

**session 选择规则**（`--email` 未指定时，镜像服务器逻辑）：
`status=active` 且 非空 key 且 目标站未注册过 → 按最久未用优先挑一个。
（一个已在 cun.ai 注册的账号，会被挑去 a6api——即「先导复用」。）

产出：更新该 session 的 `sites_registered[站]`，`results.jsonl` 追加 `source:"stage-b-oauth"` 行（**只写 key，不写 cookie**）。

前提：`sessions.jsonl` 里得先有 ① 攒下的 session，否则报「没有可复用 session」。

---

## ③ 注册 + OAuth 一条龙

`index.js` 主流程：注册 GitHub → 直接用内存里的 cookie 走 OAuth → 建 key。等价于旧版全流程。

```bash
npm start            # 完整流程
npm run dev          # 有头（HEADLESS=false）
npm run headless     # 无头（HEADLESS=true）
```

产出：`results.jsonl` 追加 `source:"fresh-registration"` 行。
注：③ 不写 `sessions.jsonl`（一条龙，session 用完即弃）；要囤 session 用 ① + ②。

---

## 定时批量（PowerShell 调度器）

按随机间隔跑 `npm run register`（即 ①）。支持串行（默认）与并发。

```powershell
# 串行（默认，-Concurrency 1）：跑完一个等 110-600s 再下一个
.\run-register-loop.ps1
.\run-register-loop.ps1 -Headless -MaxRuns 10

# 并发：同时最多 N 个 worker，各自独立 profile 目录（.chrome-profile-w<slot>）避免撞车
.\run-register-loop.ps1 -Concurrency 3 -Headless
.\run-register-loop.ps1 -Concurrency 5 -MaxRuns 50 -MinSeconds 30 -MaxSeconds 90
```

参数：
| 参数 | 默认 | 说明 |
|---|---|---|
| `-Concurrency` | 1 | 同时在跑的 worker 上限；>1 时每 worker 独立 profile |
| `-MaxRuns` | 0 | 总投放数上限（0=无限） |
| `-MinSeconds`/`-MaxSeconds` | 110/600 | 投放间隔随机范围 |
| `-Headless` | 关 | 无头 |
| `-FirstDelaySeconds` | 0 | 首次投放前等待 |

- 单实例锁（`logs/register-loop.lock`）自动生效；失败不中断；Ctrl+C 等在跑的 worker 收尾再退出
- 主日志 `logs/register-loop.log`；并发时每 worker 另有 `logs/worker-w<slot>-<seq>.log`
- **并发注意**：N 个 worker = N 个浏览器同时开，吃内存/CPU；且共用同一个 `PROXY_LIST` 随机选代理（同一代理可能被多个 worker 同时用）

---

## 服务器契约（同一份 index.js 复用 session）

服务器端 Python 编排器通过环境变量驱动 `index.js`：

```bash
OAUTH_ONLY=true SIGNUP_EMAIL=alice@han-wen.top node index.js   # 跳过注册，用已存 session 直接 OAuth
PROFILE_DIR=/path/to/profile node index.js                      # 指定 Playwright profile
EXPORT_COOKIES_PATH=/path/cookies.json node index.js            # 注册后导出 storageState
```

`OAUTH_ONLY=true` 时 cookie 来源优先级：`EXPORT_COOKIES_PATH` 文件 → `sessions.jsonl` 里按 `SIGNUP_EMAIL` 命中的 session。

---

## 常用环境变量速查

| 变量 | 作用于 | 说明 |
|---|---|---|
| `HEADLESS=true` | ① ③ | 无头 |
| `SIGNUP_EMAIL` | ① ③ | 指定邮箱（须在 `EMAIL_DOMAINS` 内） |
| `SITE_LIST=cun.ai,a6api` | ② ③ | 限定目标站 |
| `PROXY_RETRIES=3` | ① ③ | 代理故障转移最多试几个（默认 3，之后直连） |
| `EMAIL_COLLISION_RETRY=5` | ① ③ | 邮箱撞车自动换新重试上限 |
| `PRESERVE_PROFILE=1` | ① ③ | 不清 `.chrome-profile`（复用模式） |

---

## 典型工作流

```bash
# 1. 囤 100 个 GitHub session（后台循环）
.\run-register-loop.ps1 -Headless

# 2. 把 session 分批消费到引导站
SITE_LIST=cun.ai npm run oauth:site
SITE_LIST=a6api  npm run oauth:site

# 3. 未来新增引导站：在 lib/sites.js 加一条，再
SITE_LIST=新站名 npm run oauth:site   # 复用同一批老 session，零改代码
```

---

## 快速排错

| 现象 | 原因 / 处理 |
|---|---|
| `Cannot find module 'playwright'` | `npm install` + `npx playwright install chromium` |
| `Executable doesn't exist at ...` | 浏览器没下：`npx playwright install chromium` |
| `ERR_PROXY_CONNECTION_FAILED` | 代理连不上；现已自动换池里下一个→直连（`PROXY_RETRIES` 可调） |
| 卡在 Phase 3 OTP 超时 | 该邮箱域名的 Mailops catch-all/OTP 未配好，或 `MAILOPS_API_TOKEN` 失效 |
| ② 报「没有可复用 session」 | `sessions.jsonl` 无符合条件的记录；先跑 ① 攒 session |
| `domain not in whitelist` | `SIGNUP_EMAIL` 的域名不在 `EMAIL_DOMAINS` 里 |
| 调度器报「已有调度器在运行」 | 单实例锁；确认无残留后删 `logs/register-loop.lock` |
