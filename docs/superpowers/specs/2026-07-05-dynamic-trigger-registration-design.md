# Dynamic-Trigger Registration — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorming complete)

## Problem

`register:upload` currently runs on a blind fixed schedule (every 10 min via launchd on Mac,
Task Scheduler on Windows). This is wrong in both directions:

- **Pool full** → it keeps registering, wasting proxy quota and burning the GitHub-signup
  rate limit on each source IP (observed: 8 signups/hr on one proxy IP → GitHub returns
  "You can't perform that action at this time").
- **Pool draining fast** → a 10-minute fixed cadence can't respond quickly.

The root-cause fix is to **drive registration from the state of the account pool**, not from a
timer, and to **match production rate to the consumption (depletion) rate**.

## Goal

A persistent watcher on each host that:
1. Reads the usable account pool from api.nsnzd.com.
2. Measures the **depletion rate** (accounts going unusable per hour).
3. Registers **only when needed**, sized to keep the pool ahead of consumption.
4. Rotates the three SOCKS proxies to spread GitHub signups across exit IPs.
5. Never modifies `register-upload-api-nsnzd.js` — it shells out to the existing script.

## Pool metric (the signal)

**Usable pool** = api.nsnzd.com accounts with `platform=anthropic` AND `status=active` AND
`schedulable=true`.

Fetched by paging `GET /api/v1/admin/accounts?per_page=100&page=N` (auth header
`x-api-key: $API_NSNZD_COM_ADMIN_KEY`) and filtering client-side. `data.pages` gives the page
count; `data.items[]` the rows. (A cheap `per_page=1&status=active&platform=anthropic` gives
`data.total` but does NOT let us filter `schedulable`, so we page and filter.)

**Depletion rate** is derived from a sliding window of `(usable, timestamp)` snapshots the
watcher keeps in memory:

```
velocity = (usable_oldest − usable_newest) / hours_between   # accounts/hour, positive = draining
```

Only *decreases* count as depletion: `velocity = max(0, (usable_oldest − usable_newest) / hours)`.
When the watcher's own registrations push `usable` up, the window shows a net increase and velocity
clamps to 0 (we're measuring consumption pressure, not net change). This deliberately
under-estimates during active refilling, which is safe — it just means we don't over-produce.

## Architecture

One new module, `lib/pool-watcher.js`, plus a thin entry script `pool-watcher.js` and an npm
script `watch:pool`. The watcher is a long-lived process; each host runs one under its native
supervisor (launchd KeepAlive / systemd Restart=always / Task Scheduler restart wrapper).

```
pool-watcher.js (entry)  →  lib/pool-watcher.js  →  child_process → register-upload-api-nsnzd.js
                                    │
                                    └── fetch → api.nsnzd.com (pool reads)
```

### Control loop

```
load config (env + defaults)
snapshots = []            # sliding window of {usable, t}, cap WINDOW_SIZE (6)
loop forever:
  usable = readUsablePool()
  push {usable, now} into snapshots (drop oldest beyond WINDOW_SIZE)
  velocity = depletionRate(snapshots)                 # accts/hr, >=0

  target = TARGET_MIN + ceil(velocity * LOOKAHEAD_HOURS)   # dynamic target
  need   = target − usable

  if need <= 0:
     log "pool OK (usable/target), velocity=v" ; sleep IDLE_INTERVAL ; continue

  registered = 0, fails = 0
  while registered < min(need, MAX_PER_RUN):
     proxy = nextProxy()                              # round-robin over the 3
     ok = runOneRegistration(proxy)                   # spawn register:upload, inherit env+PROXY
     if ok:
        registered++, fails = 0
        usable = readUsablePool()                     # re-check between each
        if usable >= target: break                    # someone (maybe another host) caught up
     else:
        fails++
        if fails >= MAX_FAILS: break                  # proxy/GitHub wall — stop, back off
  sleep (fails >= MAX_FAILS ? FAIL_BACKOFF : ACTIVE_INTERVAL)
```

### Why this satisfies "produce at the consumption rate"

- Steady state: if the pool drains at `v` accts/hr, `target` sits `v*LOOKAHEAD` above the floor,
  so the watcher keeps `usable` hovering near that target — it registers roughly `v` accts/hr, no
  more. Consumption up → target up → more registration; consumption stops → `need<=0` → it idles.
- `TARGET_MIN` (default 15) is the safety floor so the pool never drops to zero even at zero
  measured velocity.

## Config (env vars, with defaults)

| Var | Default | Meaning |
|-----|---------|---------|
| `POOL_TARGET_MIN` | `15` | Floor the pool is kept at when idle |
| `POOL_LOOKAHEAD_HOURS` | `1` | How far ahead of the depletion rate to buffer |
| `POOL_MAX_PER_RUN` | `5` | Max registrations per active burst (safety cap) |
| `POOL_MAX_FAILS` | `2` | Consecutive failures before backing off |
| `POOL_WINDOW_SIZE` | `6` | Snapshots kept for velocity |
| `POOL_IDLE_INTERVAL_S` | `300` | Sleep when pool is healthy |
| `POOL_ACTIVE_INTERVAL_S` | `30` | Sleep between bursts when working |
| `POOL_FAIL_BACKOFF_S` | `600` | Sleep after hitting the failure wall |
| `REGISTER_PROXY_LIST` | (from .env) | Comma-separated SOCKS proxies to rotate |
| `POOL_ONESHOT` | unset | If set, run one loop iteration and exit (for testing/cron mode) |

## Multi-host coordination

Three hosts share one pool, no central lock (accepted trade-off). Coordination comes from:

1. **Re-check between every registration** (the real safety net): a host notices other hosts'
   new accounts within one registration cycle and stops early.
2. **Staggered idle phase**: hosts wake on slightly different cadences, so they rarely read the
   same snapshot simultaneously.
3. **Small `MAX_PER_RUN`**: worst-case overshoot is a couple of accounts, which is acceptable.

Precise capping (a distributed lock) is explicitly out of scope; revisit only if overshoot proves
costly.

## Proxy rotation

`nextProxy()` round-robins over `REGISTER_PROXY_LIST` (the three
`*@as.rrp.bestgo.work:10000` proxies already in `.env`). Round-robin (not random) guarantees
even spread across GitHub signups, which is what avoids the per-IP rate limit. If a proxy yields
`MAX_FAILS` consecutive failures the burst ends and the next burst starts on the next proxy.

## Per-host deployment

| Host | Supervisor | Browser | Notes |
|------|-----------|---------|-------|
| **Mac** (`haven`) | launchd `KeepAlive=true` (replaces today's `StartInterval` agent `com.nsnzd.register-upload`) | `HEADLESS=false`, system Chrome | Live-verifiable now |
| **sg_cloud** (Linux root) | systemd unit `Restart=always` | `HEADLESS=false` under **xvfb** (`DISPLAY=:99`, started by `ExecStartPre`) | Repo + deps + xvfb must be deployed first |
| **win_gw_lou** (Windows) | Task Scheduler task (trigger: at logon + repeat) whose wrapper exits immediately if the watcher is already running, else starts it | `HEADLESS=false`, system Chrome | ⚠️ upstream proxy currently unreachable from this host — install but expect failures until network fixed |

The watcher is designed to run **persistent** (long-lived process, native supervisor keeps it
alive). `POOL_ONESHOT` exists as a fallback mode so a host that can't run a daemon cleanly can
instead invoke the same logic once per timer tick — one pool read, one decision, one burst, exit.
Mac/sg_cloud use persistent mode; `POOL_ONESHOT` is the escape hatch, not the default.

Each host's wrapper exports `API_NSNZD_COM_ADMIN_KEY`, `CAPTCHA_API_KEY`, `CHROMIUM_PATH`, and
`REGISTER_PROXY_LIST`, then runs `node pool-watcher.js`.

## Error handling

- **Pool read fails** (network/API): log, keep the old snapshot window, sleep `ACTIVE_INTERVAL`,
  retry. Never register blind when the pool size is unknown.
- **Registration fails** (GitHub rate limit, proxy down, captcha): counts toward `MAX_FAILS`;
  after the wall, back off `FAIL_BACKOFF` so we don't hammer a blocked IP.
- **Watcher crashes**: the OS supervisor restarts it; the in-memory window resets (acceptable —
  it refills within `WINDOW_SIZE` reads).

## Testing

Pure logic is unit-tested with no network (node:test, matching existing `test/` style):

- `depletionRate()` — rising/falling/flat windows, clamps negatives to 0, handles <2 snapshots.
- `computeNeed()` — target = floor + ceil(velocity·lookahead); need clamps at 0; respects
  `MAX_PER_RUN`.
- `nextProxy()` — round-robins, wraps, handles single-proxy and empty lists.
- Control loop with injected fakes (fake `readUsablePool`, fake `runOneRegistration`, fake sleep):
  - idle when usable ≥ target,
  - registers exactly `need` when short and stops when re-check catches up,
  - stops at `MAX_PER_RUN`,
  - backs off after `MAX_FAILS`.

`readUsablePool()` and `runOneRegistration()` take injectable deps so the loop is testable without
hitting api.nsnzd.com or spawning browsers.

## Out of scope

- Modifying `register-upload-api-nsnzd.js` or the browser/OAuth flow.
- Distributed lock / exact pool capping.
- Webhook/push from nsnzd.com (would need server-side support).
- Fixing the win_gw_lou proxy reachability (tracked separately).
