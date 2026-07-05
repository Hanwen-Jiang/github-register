# Dynamic Pool-Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind fixed-schedule `register:upload` with a persistent pool-watcher that registers only enough accounts to stay ahead of the measured depletion rate, rotating three proxies, on Mac + sg_cloud + win_gw_lou.

**Architecture:** A new `lib/pool-watcher.js` holds all logic as small pure/injectable functions (velocity, need, proxy rotation, one control-loop tick). A thin `pool-watcher.js` entry script wires real dependencies (fetch to api.nsnzd.com, `runRegisterCliAndLoadLatest` from the existing uploader) and runs the loop forever. Deployment artifacts (launchd plist, systemd unit, Task Scheduler wrapper) run one watcher per host under a native supervisor.

**Tech Stack:** Node.js (CommonJS, `node:test`), `child_process` (via existing `runRegisterCliAndLoadLatest`), global `fetch`, launchd / systemd / Windows Task Scheduler.

## Global Constraints

- Node `>=20`, CommonJS (`require`/`module.exports`) — match the repo. No new npm dependencies.
- Do NOT modify `register-upload-api-nsnzd.js` logic or the browser/OAuth flow. The watcher only *calls* `register:upload` as a subprocess.
- Tests use `node:test` + `node:assert/strict`, live in `test/`, run via `npm test`. No network or browser in unit tests — inject fakes.
- Pool metric = api.nsnzd.com accounts with `platform=anthropic` AND `status=active` AND `schedulable=true`.
- Pool read auth header: `x-api-key: $API_NSNZD_COM_ADMIN_KEY`. Base URL `https://api.nsnzd.com`.
- Proxies to rotate (from `REGISTER_PROXY_LIST` in `.env`): the three `*-zone-custom:*@as.rrp.bestgo.work:10000`.
- Config defaults: `POOL_TARGET_MIN=15`, `POOL_LOOKAHEAD_HOURS=1`, `POOL_MAX_PER_RUN=5`, `POOL_MAX_FAILS=2`, `POOL_WINDOW_SIZE=6`, `POOL_IDLE_INTERVAL_S=300`, `POOL_ACTIVE_INTERVAL_S=30`, `POOL_FAIL_BACKOFF_S=600`.
- Secrets that schedulers don't inherit must be exported by each host wrapper: `API_NSNZD_COM_ADMIN_KEY`, `CAPTCHA_API_KEY=184adb90a084c9cb6b0afa64fc1b44af`.
- Work on branch `feat/dynamic-pool-watcher`.

---

### Task 1: Config loader

**Files:**
- Create: `lib/pool-watcher.js`
- Test: `test/pool-watcher-config.test.js`

**Interfaces:**
- Produces: `loadWatcherConfig(env = process.env) => { targetMin, lookaheadHours, maxPerRun, maxFails, windowSize, idleIntervalS, activeIntervalS, failBackoffS, proxies }` — all numbers parsed from env with the Global-Constraints defaults; `proxies` is a `string[]` parsed from `REGISTER_PROXY_LIST` (comma-split, trimmed, empties dropped).

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWatcherConfig } = require('../lib/pool-watcher');

test('loadWatcherConfig uses defaults when env is empty', () => {
  const c = loadWatcherConfig({});
  assert.equal(c.targetMin, 15);
  assert.equal(c.lookaheadHours, 1);
  assert.equal(c.maxPerRun, 5);
  assert.equal(c.maxFails, 2);
  assert.equal(c.windowSize, 6);
  assert.equal(c.idleIntervalS, 300);
  assert.equal(c.activeIntervalS, 30);
  assert.equal(c.failBackoffS, 600);
  assert.deepEqual(c.proxies, []);
});

test('loadWatcherConfig parses overrides and proxy list', () => {
  const c = loadWatcherConfig({
    POOL_TARGET_MIN: '20',
    POOL_MAX_PER_RUN: '3',
    REGISTER_PROXY_LIST: 'socks5://a:1@h:10000, socks5://b:2@h:10000 ,',
  });
  assert.equal(c.targetMin, 20);
  assert.equal(c.maxPerRun, 3);
  assert.deepEqual(c.proxies, ['socks5://a:1@h:10000', 'socks5://b:2@h:10000']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-config.test.js`
Expected: FAIL — `loadWatcherConfig is not a function` (module/file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```js
// lib/pool-watcher.js
'use strict';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadWatcherConfig(env = process.env) {
  return {
    targetMin: num(env.POOL_TARGET_MIN, 15),
    lookaheadHours: num(env.POOL_LOOKAHEAD_HOURS, 1),
    maxPerRun: num(env.POOL_MAX_PER_RUN, 5),
    maxFails: num(env.POOL_MAX_FAILS, 2),
    windowSize: num(env.POOL_WINDOW_SIZE, 6),
    idleIntervalS: num(env.POOL_IDLE_INTERVAL_S, 300),
    activeIntervalS: num(env.POOL_ACTIVE_INTERVAL_S, 30),
    failBackoffS: num(env.POOL_FAIL_BACKOFF_S, 600),
    proxies: String(env.REGISTER_PROXY_LIST || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  };
}

module.exports = { loadWatcherConfig };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-config.test.js
git commit -m "feat(pool-watcher): config loader with env defaults"
```

---

### Task 2: Depletion-rate (velocity) from snapshot window

**Files:**
- Modify: `lib/pool-watcher.js`
- Test: `test/pool-watcher-velocity.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `depletionRate(snapshots) => number` where `snapshots` is `Array<{ usable: number, t: number }>` (`t` = epoch ms). Returns accounts/hour as a non-negative number: `max(0, (oldest.usable − newest.usable) / hoursBetween)`. Returns `0` when fewer than 2 snapshots or when the time span is 0.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { depletionRate } = require('../lib/pool-watcher');

const HOUR = 3600 * 1000;

test('depletionRate returns 0 with fewer than 2 snapshots', () => {
  assert.equal(depletionRate([]), 0);
  assert.equal(depletionRate([{ usable: 10, t: 0 }]), 0);
});

test('depletionRate measures accounts lost per hour', () => {
  // 20 -> 14 over 2 hours = 3/hr
  const snaps = [{ usable: 20, t: 0 }, { usable: 14, t: 2 * HOUR }];
  assert.equal(depletionRate(snaps), 3);
});

test('depletionRate clamps growth (net increase) to 0', () => {
  const snaps = [{ usable: 10, t: 0 }, { usable: 18, t: HOUR }];
  assert.equal(depletionRate(snaps), 0);
});

test('depletionRate returns 0 when time span is 0', () => {
  assert.equal(depletionRate([{ usable: 20, t: 5 }, { usable: 10, t: 5 }]), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-velocity.test.js`
Expected: FAIL — `depletionRate is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (and add `depletionRate` to `module.exports`):

```js
function depletionRate(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 0;
  const oldest = snapshots[0];
  const newest = snapshots[snapshots.length - 1];
  const hours = (newest.t - oldest.t) / (3600 * 1000);
  if (hours <= 0) return 0;
  const lost = (oldest.usable - newest.usable) / hours;
  return lost > 0 ? lost : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-velocity.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-velocity.test.js
git commit -m "feat(pool-watcher): depletion-rate from snapshot window"
```

---

### Task 3: computeNeed — dynamic target sizing

**Files:**
- Modify: `lib/pool-watcher.js`
- Test: `test/pool-watcher-need.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `computeNeed({ usable, velocity, targetMin, lookaheadHours, maxPerRun }) => { target, need, toRegister }` where `target = targetMin + ceil(velocity * lookaheadHours)`, `need = max(0, target − usable)`, `toRegister = min(need, maxPerRun)`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeNeed } = require('../lib/pool-watcher');

test('computeNeed: idle when usable meets target', () => {
  const r = computeNeed({ usable: 15, velocity: 0, targetMin: 15, lookaheadHours: 1, maxPerRun: 5 });
  assert.equal(r.target, 15);
  assert.equal(r.need, 0);
  assert.equal(r.toRegister, 0);
});

test('computeNeed: raises target by ceil(velocity*lookahead)', () => {
  // velocity 3.2/hr, lookahead 1h -> target 15+4=19; usable 15 -> need 4
  const r = computeNeed({ usable: 15, velocity: 3.2, targetMin: 15, lookaheadHours: 1, maxPerRun: 5 });
  assert.equal(r.target, 19);
  assert.equal(r.need, 4);
  assert.equal(r.toRegister, 4);
});

test('computeNeed: caps toRegister at maxPerRun', () => {
  const r = computeNeed({ usable: 2, velocity: 0, targetMin: 15, lookaheadHours: 1, maxPerRun: 5 });
  assert.equal(r.need, 13);
  assert.equal(r.toRegister, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-need.test.js`
Expected: FAIL — `computeNeed is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (export `computeNeed`):

```js
function computeNeed({ usable, velocity, targetMin, lookaheadHours, maxPerRun }) {
  const target = targetMin + Math.ceil(velocity * lookaheadHours);
  const need = Math.max(0, target - usable);
  const toRegister = Math.min(need, maxPerRun);
  return { target, need, toRegister };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-need.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-need.test.js
git commit -m "feat(pool-watcher): computeNeed dynamic target sizing"
```

---

### Task 4: Round-robin proxy picker

**Files:**
- Modify: `lib/pool-watcher.js`
- Test: `test/pool-watcher-proxy.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `makeProxyRotator(proxies) => () => string|null` — a factory returning a stateful function that yields the next proxy each call, wrapping to the start. Returns `null` forever when `proxies` is empty.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProxyRotator } = require('../lib/pool-watcher');

test('makeProxyRotator round-robins and wraps', () => {
  const next = makeProxyRotator(['a', 'b', 'c']);
  assert.equal(next(), 'a');
  assert.equal(next(), 'b');
  assert.equal(next(), 'c');
  assert.equal(next(), 'a');
});

test('makeProxyRotator returns null for empty list', () => {
  const next = makeProxyRotator([]);
  assert.equal(next(), null);
  assert.equal(next(), null);
});

test('makeProxyRotator handles single proxy', () => {
  const next = makeProxyRotator(['only']);
  assert.equal(next(), 'only');
  assert.equal(next(), 'only');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-proxy.test.js`
Expected: FAIL — `makeProxyRotator is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (export `makeProxyRotator`):

```js
function makeProxyRotator(proxies) {
  const list = Array.isArray(proxies) ? proxies.slice() : [];
  let i = 0;
  return function next() {
    if (list.length === 0) return null;
    const proxy = list[i % list.length];
    i += 1;
    return proxy;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-proxy.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-proxy.test.js
git commit -m "feat(pool-watcher): round-robin proxy rotator"
```

---

### Task 5: readUsablePool — count schedulable anthropic-active accounts

**Files:**
- Modify: `lib/pool-watcher.js`
- Test: `test/pool-watcher-pool.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `readUsablePool({ adminKey, baseUrl = 'https://api.nsnzd.com', fetchImpl = fetch, timeoutMs = 15000 }) => Promise<number>` — pages `GET {baseUrl}/api/v1/admin/accounts?per_page=100&page=N` with header `x-api-key`, follows `data.pages`, and returns the count of `data.items[]` where `platform==='anthropic' && status==='active' && schedulable===true`. Injectable `fetchImpl` so tests supply a fake.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { readUsablePool } = require('../lib/pool-watcher');

function fakeFetch(pages) {
  // pages: array of {items, pages} keyed by page number (1-based)
  return async (url) => {
    const m = url.match(/[?&]page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    const body = pages[page - 1];
    return { ok: true, status: 200, json: async () => ({ code: 0, data: body }) };
  };
}

test('readUsablePool counts only schedulable anthropic-active across pages', async () => {
  const p1 = {
    pages: 2,
    items: [
      { platform: 'anthropic', status: 'active', schedulable: true },
      { platform: 'anthropic', status: 'active', schedulable: false }, // excluded
      { platform: 'openai', status: 'active', schedulable: true },      // excluded
    ],
  };
  const p2 = {
    pages: 2,
    items: [
      { platform: 'anthropic', status: 'error', schedulable: true },    // excluded
      { platform: 'anthropic', status: 'active', schedulable: true },   // counted
    ],
  };
  const n = await readUsablePool({ adminKey: 'k', fetchImpl: fakeFetch([p1, p2]) });
  assert.equal(n, 2);
});

test('readUsablePool throws on non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => readUsablePool({ adminKey: 'k', fetchImpl }), /pool read failed/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-pool.test.js`
Expected: FAIL — `readUsablePool is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (export `readUsablePool`):

```js
async function readUsablePool({ adminKey, baseUrl = 'https://api.nsnzd.com', fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  let page = 1;
  let usable = 0;
  for (;;) {
    const resp = await fetchImpl(`${base}/api/v1/admin/accounts?per_page=100&page=${page}`, {
      headers: { 'x-api-key': adminKey, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`pool read failed: HTTP ${resp.status}`);
    const body = await resp.json();
    const data = body && body.data ? body.data : {};
    const items = Array.isArray(data.items) ? data.items : [];
    for (const a of items) {
      if (a.platform === 'anthropic' && a.status === 'active' && a.schedulable === true) usable += 1;
    }
    const pages = Number(data.pages) || 1;
    if (page >= pages) break;
    page += 1;
  }
  return usable;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-pool.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-pool.test.js
git commit -m "feat(pool-watcher): readUsablePool paginates and filters schedulable"
```

---

### Task 6: runOneRegistration — spawn register:upload with a chosen proxy

**Files:**
- Modify: `lib/pool-watcher.js`
- Test: `test/pool-watcher-register.test.js`

**Interfaces:**
- Consumes: `runRegisterCliAndLoadLatest` from `../register-upload-api-nsnzd` (existing; signature `({ command, args, resultFile, cwd, stdio }) => Promise<result>`). NOTE: that helper runs the *inner registration CLI* (`index.js`) then loads the JSONL result — but the upload-to-nsnzd step lives in `runFullRegisterAndUpload`. For the watcher we want the WHOLE flow (register + upload), so we spawn the top-level script `register-upload-api-nsnzd.js` as a subprocess instead.
- Produces: `runOneRegistration({ proxy, env = process.env, spawnImpl }) => Promise<boolean>` — spawns `node register-upload-api-nsnzd.js` with `env` plus `PROXY=proxy`, inheriting stdio; resolves `true` on exit code 0, `false` on non-zero exit or spawn error (never throws). `spawnImpl` is injectable (defaults to `child_process.spawn`).

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { runOneRegistration } = require('../lib/pool-watcher');

function fakeSpawn(exitCode, capture) {
  return (command, args, opts) => {
    capture.command = command;
    capture.args = args;
    capture.proxy = opts.env.PROXY;
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', exitCode, null));
    return child;
  };
}

test('runOneRegistration passes PROXY and resolves true on exit 0', async () => {
  const capture = {};
  const ok = await runOneRegistration({
    proxy: 'socks5://p:1@h:10000',
    env: { FOO: 'bar' },
    spawnImpl: fakeSpawn(0, capture),
  });
  assert.equal(ok, true);
  assert.match(capture.args.join(' '), /register-upload-api-nsnzd\.js/);
  assert.equal(capture.proxy, 'socks5://p:1@h:10000');
});

test('runOneRegistration resolves false on non-zero exit', async () => {
  const ok = await runOneRegistration({ proxy: 'x', env: {}, spawnImpl: fakeSpawn(1, {}) });
  assert.equal(ok, false);
});

test('runOneRegistration resolves false on spawn error', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  const ok = await runOneRegistration({ proxy: 'x', env: {}, spawnImpl });
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-register.test.js`
Expected: FAIL — `runOneRegistration is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (top: `const path = require('path'); const { spawn } = require('child_process');`), export `runOneRegistration`:

```js
function runOneRegistration({ proxy, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'register-upload-api-nsnzd.js');
    const childEnv = { ...env };
    if (proxy) childEnv.PROXY = proxy;
    let child;
    try {
      child = spawnImpl(process.execPath, [script], {
        cwd: path.join(__dirname, '..'),
        env: childEnv,
        stdio: 'inherit',
      });
    } catch (_) {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-register.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-register.test.js
git commit -m "feat(pool-watcher): runOneRegistration spawns register:upload with proxy"
```

---

### Task 7: runTick — one control-loop iteration

**Files:**
- Modify: `lib/pool-watcher.js`
- Test: `test/pool-watcher-tick.test.js`

**Interfaces:**
- Consumes: `depletionRate`, `computeNeed` (Tasks 2–3). Deps are injected, not imported, so the tick is fully fakeable.
- Produces: `runTick({ config, snapshots, deps }) => Promise<{ snapshots, action, registered, fails, sleepS }>` where:
  - `deps = { readPool: () => Promise<number>, register: (proxy) => Promise<boolean>, nextProxy: () => string|null, now: () => number, log: (msg) => void }`.
  - Reads pool once, appends `{usable, t: now()}` to `snapshots` (capped at `config.windowSize`), computes velocity+need.
  - If `toRegister === 0`: `action='idle'`, `sleepS=config.idleIntervalS`, `registered=0`, `fails=0`.
  - Else registers in a loop up to `toRegister`: each success re-reads pool and stops early if `usable >= target`; `maxFails` consecutive failures ends the burst. `action='register'`; `sleepS = fails >= config.maxFails ? failBackoffS : activeIntervalS`.
  - Returns the updated `snapshots` (caller passes it back next tick). On pool-read error, `action='error'`, keeps snapshots unchanged, `sleepS=activeIntervalS`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTick, loadWatcherConfig } = require('../lib/pool-watcher');

const cfg = loadWatcherConfig({});          // defaults: target 15, maxPerRun 5, maxFails 2
let clock = 0;
const baseDeps = () => ({
  now: () => (clock += 1000),
  log: () => {},
  nextProxy: () => 'socks5://p@h',
});

test('runTick idles when pool at/above target', async () => {
  const deps = { ...baseDeps(), readPool: async () => 20, register: async () => true };
  const r = await runTick({ config: cfg, snapshots: [], deps });
  assert.equal(r.action, 'idle');
  assert.equal(r.registered, 0);
  assert.equal(r.sleepS, cfg.idleIntervalS);
});

test('runTick registers up to need and stops when re-check catches up', async () => {
  let pool = 13;                    // need 2 to reach 15
  let calls = 0;
  const deps = {
    ...baseDeps(),
    readPool: async () => pool,
    register: async () => { calls += 1; pool += 1; return true; }, // each reg raises pool
  };
  const r = await runTick({ config: cfg, snapshots: [], deps });
  assert.equal(r.action, 'register');
  assert.equal(calls, 2);          // 13 -> 15
  assert.equal(r.registered, 2);
});

test('runTick backs off after maxFails consecutive failures', async () => {
  const deps = { ...baseDeps(), readPool: async () => 2, register: async () => false };
  const r = await runTick({ config: cfg, snapshots: [], deps });
  assert.equal(r.fails, cfg.maxFails);
  assert.equal(r.sleepS, cfg.failBackoffS);
  assert.ok(r.registered === 0);
});

test('runTick returns action=error and keeps snapshots on read failure', async () => {
  const deps = { ...baseDeps(), readPool: async () => { throw new Error('net'); }, register: async () => true };
  const snaps = [{ usable: 10, t: 0 }];
  const r = await runTick({ config: cfg, snapshots: snaps, deps });
  assert.equal(r.action, 'error');
  assert.deepEqual(r.snapshots, snaps);
  assert.equal(r.sleepS, cfg.activeIntervalS);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-tick.test.js`
Expected: FAIL — `runTick is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (export `runTick`):

```js
function pushSnapshot(snapshots, snap, windowSize) {
  const next = snapshots.concat([snap]);
  return next.length > windowSize ? next.slice(next.length - windowSize) : next;
}

async function runTick({ config, snapshots, deps }) {
  let usable;
  try {
    usable = await deps.readPool();
  } catch (err) {
    deps.log(`[pool] read failed: ${err.message}`);
    return { snapshots, action: 'error', registered: 0, fails: 0, sleepS: config.activeIntervalS };
  }

  const window = pushSnapshot(snapshots, { usable, t: deps.now() }, config.windowSize);
  const velocity = depletionRate(window);
  const { target, need, toRegister } = computeNeed({
    usable,
    velocity,
    targetMin: config.targetMin,
    lookaheadHours: config.lookaheadHours,
    maxPerRun: config.maxPerRun,
  });

  if (toRegister <= 0) {
    deps.log(`[pool] ok usable=${usable} target=${target} velocity=${velocity.toFixed(2)}/h -> idle`);
    return { snapshots: window, action: 'idle', registered: 0, fails: 0, sleepS: config.idleIntervalS };
  }

  deps.log(`[pool] usable=${usable} target=${target} velocity=${velocity.toFixed(2)}/h -> register ${toRegister}`);
  let registered = 0;
  let fails = 0;
  let current = usable;
  while (registered < toRegister) {
    const proxy = deps.nextProxy();
    const ok = await deps.register(proxy);
    if (ok) {
      registered += 1;
      fails = 0;
      try { current = await deps.readPool(); } catch (_) { /* keep going on transient read error */ }
      if (current >= target) break;
    } else {
      fails += 1;
      if (fails >= config.maxFails) break;
    }
  }
  const sleepS = fails >= config.maxFails ? config.failBackoffS : config.activeIntervalS;
  return { snapshots: window, action: 'register', registered, fails, sleepS };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pool-watcher-tick.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js test/pool-watcher-tick.test.js
git commit -m "feat(pool-watcher): runTick single control-loop iteration"
```

---

### Task 8: runForever loop + entry script + npm script

**Files:**
- Modify: `lib/pool-watcher.js`
- Create: `pool-watcher.js` (repo-root entry)
- Modify: `package.json` (add `watch:pool` script)
- Test: `test/pool-watcher-loop.test.js`

**Interfaces:**
- Consumes: `runTick`, `loadWatcherConfig`, `readUsablePool`, `runOneRegistration`, `makeProxyRotator`.
- Produces:
  - `runForever({ config, deps, sleep, shouldContinue }) => Promise<void>` — loops `runTick`, threading `snapshots` across iterations, `await sleep(sleepS)` between ticks, stopping when `shouldContinue()` returns false (defaults to always true — real daemon runs until killed). `POOL_ONESHOT` handling lives in the entry script, not here.
  - Entry `pool-watcher.js`: builds config from `process.env`, wires real deps (`readUsablePool` with `adminKey`, `runOneRegistration`, `makeProxyRotator(config.proxies)`, `Date.now`, `console.log`), and calls `runForever`. If `process.env.POOL_ONESHOT` is set, runs a single `runTick` and exits.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runForever, loadWatcherConfig } = require('../lib/pool-watcher');

test('runForever threads snapshots across ticks and sleeps between', async () => {
  const cfg = loadWatcherConfig({ POOL_IDLE_INTERVAL_S: '7' });
  const sleeps = [];
  let ticks = 0;
  const pools = [20, 20, 20];
  const deps = {
    readPool: async () => pools[ticks] ?? 20,
    register: async () => true,
    nextProxy: () => null,
    now: () => ticks * 1000,
    log: () => {},
  };
  await runForever({
    config: cfg,
    deps,
    sleep: async (s) => { sleeps.push(s); },
    shouldContinue: () => (ticks++ < 3),
  });
  assert.equal(sleeps.length, 3);
  assert.deepEqual(sleeps, [7, 7, 7]);   // idle sleeps
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pool-watcher-loop.test.js`
Expected: FAIL — `runForever is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/pool-watcher.js` (export `runForever`):

```js
async function runForever({ config, deps, sleep, shouldContinue = () => true }) {
  let snapshots = [];
  while (shouldContinue()) {
    const res = await runTick({ config, snapshots, deps });
    snapshots = res.snapshots;
    await sleep(res.sleepS);
  }
}
```

Create `pool-watcher.js` (repo root):

```js
'use strict';
const path = require('path');
const {
  loadWatcherConfig,
  readUsablePool,
  runOneRegistration,
  makeProxyRotator,
  runTick,
  runForever,
} = require('./lib/pool-watcher');
const { loadDotEnv, normalizeAdminKey } = require('./lib/api-nsnzd-uploader');

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main() {
  applyDotEnv();
  const config = loadWatcherConfig(process.env);
  const adminKey = normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');

  const nextProxy = makeProxyRotator(config.proxies);
  const deps = {
    readPool: () => readUsablePool({ adminKey }),
    register: (proxy) => runOneRegistration({ proxy, env: process.env }),
    nextProxy,
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  };

  const sleep = (s) => new Promise(r => setTimeout(r, Math.max(0, s) * 1000));

  if (process.env.POOL_ONESHOT) {
    const res = await runTick({ config, snapshots: [], deps });
    console.log(`[pool] oneshot: action=${res.action} registered=${res.registered}`);
    return;
  }
  console.log(`[pool] watcher starting: target>=${config.targetMin}, lookahead=${config.lookaheadHours}h, proxies=${config.proxies.length}`);
  await runForever({ config, deps, sleep });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { main };
```

Add to `package.json` `scripts` (after `register:upload`):

```json
    "watch:pool": "node pool-watcher.js"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pool-watcher-loop.test.js`
Expected: PASS (1 test).
Then full suite: `npm test`
Expected: all pool-watcher tests + existing suite PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pool-watcher.js pool-watcher.js package.json test/pool-watcher-loop.test.js
git commit -m "feat(pool-watcher): runForever loop, entry script, watch:pool"
```

---

### Task 9: One-shot smoke test against the live pool (no registration)

**Files:**
- No code changes. This task validates the entry script reads the real pool.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Dry idle run (force idle by setting target below current pool)**

The current live pool is well above 15, so a plain oneshot idles without registering. Run:

```bash
cd /Users/haven/Documents/code/github-register
export API_NSNZD_COM_ADMIN_KEY='admin-238eda71c3f74210713fcc0d770f2c1f10af2a03e131819c6b637be5ff73ee8a'
POOL_ONESHOT=1 POOL_TARGET_MIN=1 node pool-watcher.js
```

Expected output includes a line like:
`[pool] ok usable=<N> target=1 velocity=0.00/h -> idle` and `[pool] oneshot: action=idle registered=0`.
(Confirms live pool read + filtering works, and that a healthy pool does NOT register.)

- [ ] **Step 2: Commit (nothing to commit — checkpoint only)**

No commit. If the smoke run failed, fix the entry wiring in Task 8 before proceeding.

---

### Task 10: Mac deployment — swap launchd agent to the watcher

**Files:**
- Modify: `/Users/haven/.local/bin/register-upload.sh` → repurpose as `~/.local/bin/pool-watcher.sh` (new wrapper)
- Create: `~/.local/bin/pool-watcher.sh`
- Modify: launchd plist `~/Library/LaunchAgents/com.nsnzd.register-upload.plist` → replace with `com.nsnzd.pool-watcher.plist` (KeepAlive)

**Interfaces:**
- Consumes: `watch:pool` npm script.

- [ ] **Step 1: Create the watcher wrapper**

Write `/Users/haven/.local/bin/pool-watcher.sh`:

```bash
#!/bin/zsh
# Persistent pool-watcher for github-register. Kept alive by launchd:
#   ~/Library/LaunchAgents/com.nsnzd.pool-watcher.plist
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd /Users/haven/Documents/code/github-register || exit 1

export API_NSNZD_COM_ADMIN_KEY='admin-238eda71c3f74210713fcc0d770f2c1f10af2a03e131819c6b637be5ff73ee8a'
export CAPTCHA_API_KEY='184adb90a084c9cb6b0afa64fc1b44af'
export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export HEADLESS=false
# REGISTER_PROXY_LIST is read from .env; the watcher rotates it.

echo "===== $(date '+%Y-%m-%d %H:%M:%S') pool-watcher starting ====="
exec npm run watch:pool
```

Then: `chmod +x /Users/haven/.local/bin/pool-watcher.sh`

- [ ] **Step 2: Write the new plist**

Write `~/Library/LaunchAgents/com.nsnzd.pool-watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.nsnzd.pool-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>/Users/haven/.local/bin/pool-watcher.sh</string>
    </array>
    <key>KeepAlive</key><true/>
    <key>RunAtLoad</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>WorkingDirectory</key><string>/Users/haven/Documents/code/github-register</string>
    <key>StandardOutPath</key><string>/Users/haven/Library/Logs/register-upload/watcher.log</string>
    <key>StandardErrorPath</key><string>/Users/haven/Library/Logs/register-upload/watcher.err.log</string>
    <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
```

- [ ] **Step 3: Unload the old blind-schedule agent, load the watcher**

Run (sandbox disabled — talks to launchd GUI session):

```bash
UID_=$(id -u)
plutil -lint ~/Library/LaunchAgents/com.nsnzd.pool-watcher.plist
launchctl bootout "gui/$UID_/com.nsnzd.register-upload" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" ~/Library/LaunchAgents/com.nsnzd.pool-watcher.plist
launchctl enable "gui/$UID_/com.nsnzd.pool-watcher"
launchctl print "gui/$UID_/com.nsnzd.pool-watcher" | grep -iE "state|run interval|program ="
```

Expected: `state = running`. The old `com.nsnzd.register-upload` is gone.

- [ ] **Step 4: Verify the watcher is looping**

```bash
sleep 8
tail -n 20 /Users/haven/Library/Logs/register-upload/watcher.log
```

Expected: a `pool-watcher starting` banner and a `[pool] ok usable=… -> idle` (pool currently >15) OR `-> register N` if it has dropped. No crash-restart loop in `watcher.err.log`.

- [ ] **Step 5: Remove the now-dead old wrapper + plist file from disk and commit deployment notes**

```bash
rm -f /Users/haven/.local/bin/register-upload.sh
rm -f ~/Library/LaunchAgents/com.nsnzd.register-upload.plist
cd /Users/haven/Documents/code/github-register
# (deployment artifacts live outside the repo; commit only if you keep copies in-repo)
```

No repo commit required unless you keep host artifacts in-repo (see Task 12).

---

### Task 11: sg_cloud deployment — deploy source, xvfb, systemd unit

**Files:**
- Remote (sg_cloud): repo at `~/github-register`, `/etc/systemd/system/pool-watcher.service`, wrapper `~/github-register/deploy/sg_cloud/pool-watcher.sh`
- Create (in-repo): `deploy/sg_cloud/pool-watcher.service`, `deploy/sg_cloud/pool-watcher.sh`

**Interfaces:**
- Consumes: `watch:pool`.

- [ ] **Step 1: Add in-repo deploy artifacts**

Create `deploy/sg_cloud/pool-watcher.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
cd /root/github-register
export API_NSNZD_COM_ADMIN_KEY='admin-238eda71c3f74210713fcc0d770f2c1f10af2a03e131819c6b637be5ff73ee8a'
export CAPTCHA_API_KEY='184adb90a084c9cb6b0afa64fc1b44af'
export CHROMIUM_PATH="/usr/bin/chromium-browser"
export HEADLESS=false
export DISPLAY=:99
exec npm run watch:pool
```

Create `deploy/sg_cloud/pool-watcher.service`:

```ini
[Unit]
Description=github-register pool watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=/usr/bin/bash -c 'pgrep -x Xvfb >/dev/null || (Xvfb :99 -screen 0 1280x1024x24 &) ; sleep 2'
ExecStart=/root/github-register/deploy/sg_cloud/pool-watcher.sh
Restart=always
RestartSec=15
StandardOutput=append:/var/log/pool-watcher.log
StandardError=append:/var/log/pool-watcher.err.log

[Install]
WantedBy=multi-user.target
```

Commit:

```bash
git add deploy/sg_cloud/pool-watcher.sh deploy/sg_cloud/pool-watcher.service
git commit -m "feat(pool-watcher): sg_cloud systemd + xvfb deploy artifacts"
```

- [ ] **Step 2: Deploy source to sg_cloud**

```bash
cd /Users/haven/Documents/code/github-register
git archive --format=tar.gz -o /tmp/ghreg.tgz feat/dynamic-pool-watcher
ssh sg_cloud 'mkdir -p /root/github-register'
scp /tmp/ghreg.tgz sg_cloud:/tmp/ghreg.tgz
scp .env sg_cloud:/root/github-register/.env
ssh sg_cloud 'cd /root/github-register && tar -xzf /tmp/ghreg.tgz && chmod +x deploy/sg_cloud/pool-watcher.sh'
```

(Run these with the sandbox disabled — SSH/scp to `186.244.238.119`.)

- [ ] **Step 3: Install deps + xvfb + chromium on sg_cloud**

```bash
ssh sg_cloud 'command -v Xvfb || (apt-get update && apt-get install -y xvfb)'
ssh sg_cloud 'cd /root/github-register && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci'
ssh sg_cloud 'cd /root/github-register && node -e "require(\"playwright\");require(\"socks-proxy-agent\");console.log(\"deps_ok\")"'
```

Expected: `deps_ok`.

- [ ] **Step 4: Install and start the systemd service**

```bash
ssh sg_cloud 'cp /root/github-register/deploy/sg_cloud/pool-watcher.service /etc/systemd/system/pool-watcher.service && systemctl daemon-reload && systemctl enable --now pool-watcher.service'
ssh sg_cloud 'sleep 8; systemctl is-active pool-watcher.service; tail -n 20 /var/log/pool-watcher.log'
```

Expected: `active`, and a `[pool] ...` line in the log.

- [ ] **Step 5: Checkpoint (no repo commit — done in Step 1)**

Confirm `systemctl is-active` is `active` and the err log shows no restart loop.

---

### Task 12: win_gw_lou deployment — Task Scheduler relaunch wrapper (install; expect proxy-blocked)

**Files:**
- Create (in-repo): `deploy/win_gw_lou/pool-watcher.ps1`, `deploy/win_gw_lou/install-task.ps1`
- Remote (Windows): `C:\Users\Lou\register-upload\pool-watcher.ps1`, scheduled task `pool-watcher`

**Interfaces:**
- Consumes: `watch:pool`.

- [ ] **Step 1: Add in-repo Windows artifacts**

Create `deploy/win_gw_lou/pool-watcher.ps1`:

```powershell
$ErrorActionPreference = 'Continue'
$env:PATH = 'D:\nvm4w\nodejs;' + $env:PATH
Set-Location 'C:\Users\Lou\mftx\inbox\github-register'
$env:API_NSNZD_COM_ADMIN_KEY = 'admin-238eda71c3f74210713fcc0d770f2c1f10af2a03e131819c6b637be5ff73ee8a'
$env:CAPTCHA_API_KEY = '184adb90a084c9cb6b0afa64fc1b44af'
$env:CHROMIUM_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:HEADLESS = 'false'
"===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') pool-watcher starting ====="
npm run watch:pool
```

Create `deploy/win_gw_lou/install-task.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$dir = 'C:\Users\Lou\register-upload'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ps1 = Join-Path $dir 'pool-watcher.ps1'
$log = Join-Path $dir 'pool-watcher.log'
# guard wrapper: only start if not already running
$arg = '-NoProfile -ExecutionPolicy Bypass -Command "if (-not (Get-CimInstance Win32_Process -Filter ''Name=\"node.exe\"'' | Where-Object { $_.CommandLine -like ''*pool-watcher*'' })) { & ''' + $ps1 + ''' *>> ''' + $log + ''' }"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger1 = New-ScheduledTaskTrigger -AtLogOn
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'pool-watcher' -Action $action -Trigger @($trigger1,$trigger2) -Principal $principal -Settings $settings -Force | Out-Null
'REGISTERED_OK'
```

Commit:

```bash
git add deploy/win_gw_lou/pool-watcher.ps1 deploy/win_gw_lou/install-task.ps1
git commit -m "feat(pool-watcher): win_gw_lou Task Scheduler relaunch artifacts"
```

- [ ] **Step 2: Remove the old blind-schedule Windows task**

```bash
ssh win_gw_lou "powershell -NoProfile -Command \"Unregister-ScheduledTask -TaskName 'register-upload' -Confirm:\$false -ErrorAction SilentlyContinue; 'removed'\""
```

- [ ] **Step 3: Deploy updated source + install the watcher task**

```bash
cd /Users/haven/Documents/code/github-register
git archive --format=tar.gz feat/dynamic-pool-watcher | ssh win_gw_lou "powershell -NoProfile -Command \"\$in=[Console]::OpenStandardInput(); \$fs=[IO.File]::Create('C:\\Users\\Lou\\ghreg.tgz'); \$in.CopyTo(\$fs); \$fs.Close()\""
ssh win_gw_lou "powershell -NoProfile -Command \"cd 'C:\\Users\\Lou\\mftx\\inbox\\github-register'; tar -xzf 'C:\\Users\\Lou\\ghreg.tgz'; D:\\nvm4w\\nodejs\\npm.ps1 ci 2>&1 | Select-Object -Last 5\""
```

Then install the task by sending `install-task.ps1` base64-encoded (same pattern used previously). Expected `REGISTERED_OK`.

- [ ] **Step 4: Start once and capture the expected proxy failure**

```bash
ssh win_gw_lou "powershell -NoProfile -Command \"Start-ScheduledTask -TaskName 'pool-watcher'; Start-Sleep 20; Get-Content 'C:\\Users\\Lou\\register-upload\\pool-watcher.log' -Tail 20\""
```

Expected: `[pool] watcher starting…` then, when it tries to register, `ERR_SOCKS_CONNECTION_FAILED` (documented-known: this host's proxy egress is broken). The watcher itself should still be looping (idle reads succeed via the direct API path). **This is the known-blocked state — do not treat the proxy error as a plan failure.**

- [ ] **Step 5: Checkpoint**

Confirm the pool *read* succeeds from Windows (the API call to api.nsnzd.com works even though the SOCKS proxy for GitHub does not). If reads fail too, note it; registration will stay blocked until the proxy/network issue is resolved separately.

---

## Self-Review

**Spec coverage:**
- Pool metric (anthropic+active+schedulable) → Task 5. ✓
- Depletion rate → Task 2. ✓
- Dynamic target/need → Task 3. ✓
- Proxy rotation (round-robin over REGISTER_PROXY_LIST) → Task 4. ✓
- Control loop (idle/register/backoff, re-check between regs) → Tasks 7–8. ✓
- Config env vars + defaults → Task 1. ✓
- Do-not-modify register script; spawn subprocess → Task 6. ✓
- Mac launchd KeepAlive → Task 10. ✓
- sg_cloud systemd + xvfb → Task 11. ✓
- win_gw_lou Task Scheduler + known proxy-blocked → Task 12. ✓
- POOL_ONESHOT fallback → Task 8 entry + Task 9 smoke. ✓
- Error handling (pool read fail keeps snapshots; fail backoff) → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**Type consistency:** `snapshots` is `{usable,t}[]` in Tasks 2,7,8. `runTick`/`runForever` thread the same object. `readPool/register/nextProxy/now/log` deps names identical across Tasks 7–8. `computeNeed` returns `{target,need,toRegister}` used verbatim in Task 7. ✓

## Execution Handoff

(see message)
