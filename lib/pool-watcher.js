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

module.exports = { loadWatcherConfig, depletionRate, computeNeed, makeProxyRotator };
