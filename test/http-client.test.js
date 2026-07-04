const test = require('node:test');
const assert = require('node:assert/strict');
const { CookieJar } = require('../lib/http-client');

test('CookieJar imports Playwright cookies and scopes them by request host', () => {
  const jar = new CookieJar();
  jar.importPlaywrightCookies([
    { name: '_gh_sess', value: 'abc', domain: '.github.com', path: '/' },
    { name: 'session', value: 'site', domain: 'www.cun.ai', path: '/' },
    { name: 'session', value: 'api', domain: 'a6api.com', path: '/' },
  ]);
  assert.equal(jar.getCookieHeader('https://github.com/login/oauth/authorize'), '_gh_sess=abc');
  assert.equal(jar.getCookieHeader('https://www.cun.ai/api/user/self'), 'session=site');
  assert.equal(jar.getCookieHeader('https://a6api.com/api/user/self'), 'session=api');
});

test('CookieJar stores multiple Set-Cookie headers without merging domains incorrectly', () => {
  const jar = new CookieJar();
  jar.storeFromHeaders('https://www.cun.ai/sign-in', {
    'set-cookie': [
      'session=one; Path=/; Domain=www.cun.ai; HttpOnly',
      'other=two; Path=/; HttpOnly',
    ],
  });
  assert.equal(jar.getCookieHeader('https://www.cun.ai/keys'), 'session=one; other=two');
  assert.equal(jar.getCookieHeader('https://a6api.com/keys'), '');
});

test('HttpClient sends cookies, stores response cookies, and encodes form/json bodies', async () => {
  const { HttpClient } = require('../lib/http-client');
  const calls = [];
  const transport = async (url, opts) => {
    calls.push({ url, opts });
    if (url === 'https://www.cun.ai/sign-in') {
      return {
        status: 200,
        headers: { 'set-cookie': ['session=abc; Path=/; Domain=www.cun.ai'] },
        text: () => '<html></html>',
        json: () => null,
      };
    }
    if (url === 'https://www.cun.ai/form') {
      return { status: 302, headers: { location: 'https://www.cun.ai/next' }, text: () => '', json: () => null };
    }
    if (url === 'https://www.cun.ai/api/token/') {
      return { status: 200, headers: {}, text: () => '{"success":true}', json: () => ({ success: true }) };
    }
    throw new Error(`unexpected ${url}`);
  };

  const client = new HttpClient({ transport });
  await client.get('https://www.cun.ai/sign-in');
  await client.postForm('https://www.cun.ai/form', { a: '1', b: 'two words' });
  await client.postJson('https://www.cun.ai/api/token/', { name: 'claude' });

  assert.equal(calls[1].opts.headers.cookie, 'session=abc');
  assert.equal(calls[1].opts.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[1].opts.body, 'a=1&b=two+words');
  assert.equal(calls[2].opts.headers.cookie, 'session=abc');
  assert.equal(calls[2].opts.headers['content-type'], 'application/json');
  assert.equal(calls[2].opts.body, '{"name":"claude"}');
});

test('createDefaultTransport uses direct transport without proxy and initializes socks when proxy is provided', async () => {
  const { createDefaultTransport } = require('../lib/http-client');
  let initialized = null;
  const noProxy = createDefaultTransport('', { directRequest: async () => 'direct', socksRequest: async () => 'socks', initSocks: p => { initialized = p; } });
  assert.equal(await noProxy('https://example.test', {}), 'direct');
  assert.equal(initialized, null);

  const socks = createDefaultTransport('socks5://127.0.0.1:2080', { directRequest: async () => 'direct', socksRequest: async () => 'socks', initSocks: p => { initialized = p; } });
  assert.equal(await socks('https://example.test', {}), 'socks');
  assert.equal(initialized, 'socks5://127.0.0.1:2080');
});

test('HttpClient constructor passes proxyUrl into default transport factory', async () => {
  const { HttpClient } = require('../lib/http-client');
  let seenProxy = null;
  const client = new HttpClient({
    proxyUrl: 'socks5://127.0.0.1:2999',
    createTransport: (proxyUrl) => {
      seenProxy = proxyUrl;
      return async () => ({ status: 200, headers: {}, text: () => 'ok', json: () => null });
    },
  });
  const resp = await client.get('https://example.test/path');
  assert.equal(resp.text(), 'ok');
  assert.equal(seenProxy, 'socks5://127.0.0.1:2999');
});

test('HttpClient postJson can send an empty POST body when body is null', async () => {
  const { HttpClient } = require('../lib/http-client');
  const calls = [];
  const client = new HttpClient({
    transport: async (url, opts) => {
      calls.push({ url, opts });
      return { status: 200, headers: {}, text: () => '{}', json: () => ({}) };
    }
  });
  await client.postJson('https://www.cun.ai/api/token/7/key', null, { 'content-length': '0' });
  assert.equal(calls[0].opts.body, '');
  assert.equal(calls[0].opts.headers['content-length'], '0');
});
