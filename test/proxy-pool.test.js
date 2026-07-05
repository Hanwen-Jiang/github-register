const test = require('node:test');
const assert = require('node:assert/strict');
const { generateProxyPool } = require('../lib/proxy-pool');

test('generateProxyPool builds count proxies with zero-padded index', () => {
  const pool = generateProxyPool({ count: 100 });
  assert.equal(pool.length, 100);
  assert.equal(pool[0], 'socks5://jhw001-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
  assert.equal(pool[9], 'socks5://jhw010-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
  assert.equal(pool[99], 'socks5://jhw100-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
});

test('generateProxyPool respects custom count and password', () => {
  const pool = generateProxyPool({ count: 3, password: 'pw' });
  assert.deepEqual(pool, [
    'socks5://jhw001-zone-custom:pw@as.rrp.bestgo.work:10000',
    'socks5://jhw002-zone-custom:pw@as.rrp.bestgo.work:10000',
    'socks5://jhw003-zone-custom:pw@as.rrp.bestgo.work:10000',
  ]);
});
