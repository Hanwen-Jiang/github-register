'use strict';

const path = require('path');
const { spawn } = require('child_process');

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

function depletionRate(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 0;
  const oldest = snapshots[0];
  const newest = snapshots[snapshots.length - 1];
  const hours = (newest.t - oldest.t) / (3600 * 1000);
  if (hours <= 0) return 0;
  const lost = (oldest.usable - newest.usable) / hours;
  return lost > 0 ? lost : 0;
}

function computeNeed({ usable, velocity, targetMin, lookaheadHours, maxPerRun }) {
  const target = targetMin + Math.ceil(velocity * lookaheadHours);
  const need = Math.max(0, target - usable);
  const toRegister = Math.min(need, maxPerRun);
  return { target, need, toRegister };
}

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

module.exports = { loadWatcherConfig, depletionRate, computeNeed, makeProxyRotator, readUsablePool, runOneRegistration, runTick };
