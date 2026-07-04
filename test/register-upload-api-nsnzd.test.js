const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureProxyConfigured,
  maskProxy,
} = require('../register-upload-api-nsnzd');

test('maskProxy hides proxy passwords in logs', () => {
  assert.equal(
    maskProxy('socks5://user:secret@example.com:10000'),
    'socks5://user:***@example.com:10000'
  );
});

test('ensureProxyConfigured picks one proxy from REGISTER_PROXY_LIST when no proxy is configured', () => {
  const oldProxy = process.env.PROXY;
  const oldList = process.env.PROXY_LIST;
  const oldRegisterList = process.env.REGISTER_PROXY_LIST;
  const proxyList = [
    'socks5://first:secret@example.com:10000',
    'socks5://second:secret@example.com:10000',
  ];
  delete process.env.PROXY;
  delete process.env.PROXY_LIST;
  process.env.REGISTER_PROXY_LIST = proxyList.join(',');
  try {
    ensureProxyConfigured();
    assert.ok(proxyList.includes(process.env.PROXY));
  } finally {
    if (oldProxy === undefined) delete process.env.PROXY; else process.env.PROXY = oldProxy;
    if (oldList === undefined) delete process.env.PROXY_LIST; else process.env.PROXY_LIST = oldList;
    if (oldRegisterList === undefined) delete process.env.REGISTER_PROXY_LIST; else process.env.REGISTER_PROXY_LIST = oldRegisterList;
  }
});

test('ensureProxyConfigured keeps an explicitly configured proxy', () => {
  const oldProxy = process.env.PROXY;
  const oldList = process.env.PROXY_LIST;
  const oldRegisterList = process.env.REGISTER_PROXY_LIST;
  process.env.PROXY = 'socks5://manual:secret@example.com:10000';
  delete process.env.PROXY_LIST;
  delete process.env.REGISTER_PROXY_LIST;
  try {
    ensureProxyConfigured();
    assert.equal(process.env.PROXY, 'socks5://manual:secret@example.com:10000');
  } finally {
    if (oldProxy === undefined) delete process.env.PROXY; else process.env.PROXY = oldProxy;
    if (oldList === undefined) delete process.env.PROXY_LIST; else process.env.PROXY_LIST = oldList;
    if (oldRegisterList === undefined) delete process.env.REGISTER_PROXY_LIST; else process.env.REGISTER_PROXY_LIST = oldRegisterList;
  }
});
