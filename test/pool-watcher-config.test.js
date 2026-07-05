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
