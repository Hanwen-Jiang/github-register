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
