const test = require('node:test');
const assert = require('node:assert/strict');
const { runSiteOAuthHttp } = require('../lib/hybrid-oauth');

test('runSiteOAuthHttp completes GitHub OAuth callback and creates target token over HTTP', async () => {
  const calls = [];
  const transport = async (url, opts) => {
    calls.push({ url, opts });

    if (url === 'https://www.cun.ai/sign-in') {
      return { status: 200, headers: { 'set-cookie': ['pre=one; Path=/; Domain=www.cun.ai'] }, text: () => '', json: () => null };
    }
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') {
      return { status: 200, headers: {}, text: () => '{"success":true,"data":"STATE123"}', json: () => ({ success: true, data: 'STATE123' }) };
    }
    if (url.startsWith('https://github.com/login/oauth/authorize?')) {
      assert.equal(opts.headers.cookie, '_gh_sess=github-session');
      return {
        status: 200,
        headers: {},
        text: () => '<form action="/login/oauth/authorize" method="post"><input name="authenticity_token" value="AUTH"><input name="client_id" value="CLIENT"><button class="js-oauth-authorize-btn"></button></form>',
        json: () => null,
      };
    }
    if (url === 'https://github.com/login/oauth/authorize') {
      assert.equal(opts.method, 'POST');
      assert.match(opts.body, /authenticity_token=AUTH/);
      assert.match(opts.body, /client_id=CLIENT/);
      assert.match(opts.body, /state=STATE123/);
      return { status: 302, headers: { location: 'https://www.cun.ai/oauth/github?code=CODE&state=STATE123' }, text: () => '', json: () => null };
    }
    if (url === 'https://www.cun.ai/oauth/github?code=CODE&state=STATE123') {
      return { status: 302, headers: { location: 'https://www.cun.ai/dashboard', 'set-cookie': ['session=target-session; Path=/; Domain=www.cun.ai'] }, text: () => '', json: () => null };
    }
    if (url === 'https://www.cun.ai/dashboard') {
      return { status: 200, headers: {}, text: () => 'dashboard', json: () => null };
    }
    if (url === 'https://www.cun.ai/api/user/self') {
      assert.equal(opts.headers.cookie, 'pre=one; session=target-session');
      return { status: 200, headers: {}, text: () => '{"success":true,"data":{"id":42}}', json: () => ({ success: true, data: { id: 42 } }) };
    }
    if (url === 'https://www.cun.ai/api/token/') {
      assert.equal(opts.method, 'POST');
      assert.equal(opts.headers['new-api-user'], '42');
      return { status: 200, headers: {}, text: () => '{"success":true}', json: () => ({ success: true }) };
    }
    if (url === 'https://www.cun.ai/api/token/?p=1&size=20') {
      return { status: 200, headers: {}, text: () => '{"data":{"items":[{"id":7,"name":"claude","created_time":10}]}}', json: () => ({ data: { items: [{ id: 7, name: 'claude', created_time: 10 }] } }) };
    }
    if (url === 'https://www.cun.ai/api/token/7/key') {
      assert.equal(opts.method, 'POST');
      return { status: 200, headers: {}, text: () => '{"success":true,"data":{"key":"abc"}}', json: () => ({ success: true, data: { key: 'abc' } }) };
    }
    throw new Error(`unexpected ${url}`);
  };

  const result = await runSiteOAuthHttp(
    { name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT', tokenName: 'claude', tokenRemainQuota: 0, tokenExpiredTime: -1, tokenUnlimitedQuota: true },
    [{ name: '_gh_sess', value: 'github-session', domain: '.github.com', path: '/' }],
    { transport }
  );

  assert.deepEqual(result, { site: 'cun.ai', baseUrl: 'https://www.cun.ai', userId: '42', keys: [{ apiKey: 'sk-abc', profile: null }] });
  assert.deepEqual(calls.map(c => c.url), [
    'https://www.cun.ai/sign-in',
    'https://www.cun.ai/api/oauth/state?aff=',
    'https://github.com/login/oauth/authorize?client_id=CLIENT&state=STATE123&scope=user%3Aemail',
    'https://github.com/login/oauth/authorize',
    'https://www.cun.ai/api/oauth/github?code=CODE&state=STATE123',
    'https://www.cun.ai/oauth/github?code=CODE&state=STATE123',
    'https://www.cun.ai/dashboard',
    'https://www.cun.ai/api/user/self',
    'https://www.cun.ai/api/token/',
    'https://www.cun.ai/api/token/?p=1&size=20',
    'https://www.cun.ai/api/token/7/key',
  ]);
});

test('runSiteOAuthHttp includes self response diagnostics when user id is missing', async () => {
  const transport = async (url, opts) => {
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return { status: 302, headers: { location: 'https://www.cun.ai/oauth/github?code=CODE&state=STATE123' }, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/oauth/github?code=CODE&state=STATE123') return { status: 302, headers: { location: 'https://www.cun.ai/sign-in' }, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/user/self') return { status: 401, headers: {}, text: () => '{"success":false,"message":"unauthorized"}', json: () => ({ success: false, message: 'unauthorized' }) };
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(
    () => runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport }),
    /unable to fetch user id.*status=401.*unauthorized/
  );
});

test('runSiteOAuthHttp includes sanitized oauth trace when user id is missing', async () => {
  const transport = async (url, opts) => {
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return { status: 302, headers: { location: 'https://www.cun.ai/oauth/github?code=SECRET_CODE&state=STATE123' }, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/oauth/github?code=SECRET_CODE&state=STATE123') return { status: 302, headers: { location: 'https://www.cun.ai/sign-in' }, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/user/self') return { status: 401, headers: {}, text: () => '{"success":false,"message":"unauthorized"}', json: () => ({ success: false, message: 'unauthorized' }) };
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(
    () => runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport }),
    (err) => {
      assert.match(err.message, /trace=/);
      assert.match(err.message, /github_authorize_get:302/);
      assert.match(err.message, /https:\/\/www\.cun\.ai\/oauth\/github\?code=<redacted>&state=STATE123/);
      assert.doesNotMatch(err.message, /SECRET_CODE/);
      return true;
    }
  );
});

test('followRedirects records each hop without exposing OAuth code', async () => {
  const { followRedirects } = require('../lib/hybrid-oauth');
  const trace = [];
  const client = {
    async get(url) {
      if (url === 'https://www.cun.ai/oauth/github?code=SECRET&state=S') {
        return { status: 302, headers: { location: 'https://www.cun.ai/dashboard', 'set-cookie': ['session=abc; Path=/'] }, text: () => '', json: () => null };
      }
      if (url === 'https://www.cun.ai/dashboard') {
        return { status: 200, headers: {}, text: () => 'ok', json: () => null };
      }
      throw new Error(`unexpected ${url}`);
    }
  };
  await followRedirects(client, 'https://www.cun.ai/oauth/github?code=SECRET&state=S', 5, trace);
  assert.deepEqual(trace, [
    'follow:302:https://www.cun.ai/oauth/github?code=<redacted>&state=S set-cookie -> https://www.cun.ai/dashboard',
    'follow:200:https://www.cun.ai/dashboard',
  ]);
});

test('runSiteOAuthHttp includes authorize post body summary when GitHub does not redirect', async () => {
  const transport = async (url, opts) => {
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return {
      status: 200,
      headers: {},
      text: () => '<form><input name="authenticity_token" value="AUTH"></form>',
      json: () => null,
    };
    if (url === 'https://github.com/login/oauth/authorize') return {
      status: 200,
      headers: {},
      text: () => '<html><div class="flash flash-error">You need to verify your email before authorizing</div></html>',
      json: () => null,
    };
    if (url === 'https://www.cun.ai/api/user/self') return { status: 401, headers: {}, text: () => '{"message":"Unauthorized"}', json: () => ({ message: 'Unauthorized' }) };
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(
    () => runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport }),
    /github_authorize_post:200.*You need to verify your email before authorizing/
  );
});

test('runSiteOAuthHttp follows callback link from GitHub OAuth authorized HTML page', async () => {
  const calls = [];
  const transport = async (url, opts) => {
    calls.push(url);
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return {
      status: 200,
      headers: {},
      text: () => '<form><input name="authenticity_token" value="AUTH"><input name="client_id" value="CLIENT"></form>',
      json: () => null,
    };
    if (url === 'https://github.com/login/oauth/authorize') return {
      status: 200,
      headers: {},
      text: () => '<html><body>OAuth application authorized <a id="js-manual-authorize-redirect" href="https://www.cun.ai/oauth/github?code=SECRET_CODE&state=STATE123">continue</a></body></html>',
      json: () => null,
    };
    if (url === 'https://www.cun.ai/api/oauth/github?code=SECRET_CODE&state=STATE123') return {
      status: 200,
      headers: { 'set-cookie': ['session=target-session; Path=/; Domain=www.cun.ai'] },
      text: () => '{"success":true,"data":{"id":42}}',
      json: () => ({ success: true, data: { id: 42 } }),
    };
    if (url === 'https://www.cun.ai/api/user/self') return { status: 200, headers: {}, text: () => '{"data":{"id":42}}', json: () => ({ data: { id: 42 } }) };
    if (url === 'https://www.cun.ai/api/token/') return { status: 200, headers: {}, text: () => '{"success":true}', json: () => ({ success: true }) };
    if (url === 'https://www.cun.ai/api/token/?p=1&size=20') return { status: 200, headers: {}, text: () => '{"data":{"items":[{"id":7,"created_time":1}]}}', json: () => ({ data: { items: [{ id: 7, created_time: 1 }] } }) };
    if (url === 'https://www.cun.ai/api/token/7/key') return { status: 200, headers: {}, text: () => '{"success":true,"data":{"key":"abc"}}', json: () => ({ success: true, data: { key: 'abc' } }) };
    throw new Error(`unexpected ${url}`);
  };
  const result = await runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport });
  assert.equal(result.keys[0].apiKey, 'sk-abc');
  assert.ok(calls.includes('https://www.cun.ai/api/oauth/github?code=SECRET_CODE&state=STATE123'));
});

test('runSiteOAuthHttp calls target OAuth API after extracting SPA callback URL', async () => {
  const calls = [];
  const transport = async (url, opts) => {
    calls.push(url);
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return {
      status: 200,
      headers: {},
      text: () => '<form><input name="authenticity_token" value="AUTH"><input name="client_id" value="CLIENT"></form>',
      json: () => null,
    };
    if (url === 'https://github.com/login/oauth/authorize') return {
      status: 200,
      headers: {},
      text: () => '<html><a href="https://www.cun.ai/oauth/github?code=SECRET_CODE&state=STATE123">continue</a></html>',
      json: () => null,
    };
    if (url === 'https://www.cun.ai/api/oauth/github?code=SECRET_CODE&state=STATE123') return {
      status: 200,
      headers: { 'set-cookie': ['session=target-session; Path=/; Domain=www.cun.ai'] },
      text: () => '{"success":true,"data":{"id":42}}',
      json: () => ({ success: true, data: { id: 42 } }),
    };
    if (url === 'https://www.cun.ai/api/user/self') return { status: 200, headers: {}, text: () => '{"data":{"id":42}}', json: () => ({ data: { id: 42 } }) };
    if (url === 'https://www.cun.ai/api/token/') return { status: 200, headers: {}, text: () => '{"success":true}', json: () => ({ success: true }) };
    if (url === 'https://www.cun.ai/api/token/?p=1&size=20') return { status: 200, headers: {}, text: () => '{"data":{"items":[{"id":7,"created_time":1}]}}', json: () => ({ data: { items: [{ id: 7, created_time: 1 }] } }) };
    if (url === 'https://www.cun.ai/api/token/7/key') return { status: 200, headers: {}, text: () => '{"success":true,"data":{"key":"abc"}}', json: () => ({ success: true, data: { key: 'abc' } }) };
    throw new Error(`unexpected ${url}`);
  };
  const result = await runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport });
  assert.equal(result.keys[0].apiKey, 'sk-abc');
  assert.ok(calls.includes('https://www.cun.ai/api/oauth/github?code=SECRET_CODE&state=STATE123'));
});

test('runSiteOAuthHttp reuses user id returned by target OAuth API callback', async () => {
  const calls = [];
  const transport = async (url, opts) => {
    calls.push({ url, opts });
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return { status: 200, headers: {}, text: () => '<form><input name="authenticity_token" value="AUTH"></form>', json: () => null };
    if (url === 'https://github.com/login/oauth/authorize') return { status: 200, headers: {}, text: () => '<a href="https://www.cun.ai/oauth/github?code=SECRET&state=STATE123">continue</a>', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/github?code=SECRET&state=STATE123') return {
      status: 200,
      headers: { 'set-cookie': ['session=target-session; Path=/; Domain=www.cun.ai'] },
      text: () => '{"success":true,"data":{"id":9202,"username":"github_9202"}}',
      json: () => ({ success: true, data: { id: 9202, username: 'github_9202' } }),
    };
    if (url === 'https://www.cun.ai/api/token/') {
      assert.equal(opts.headers['new-api-user'], '9202');
      return { status: 200, headers: {}, text: () => '{"success":true}', json: () => ({ success: true }) };
    }
    if (url === 'https://www.cun.ai/api/token/?p=1&size=20') return { status: 200, headers: {}, text: () => '{"data":{"items":[{"id":7,"created_time":1}]}}', json: () => ({ data: { items: [{ id: 7, created_time: 1 }] } }) };
    if (url === 'https://www.cun.ai/api/token/7/key') return { status: 200, headers: {}, text: () => '{"success":true,"data":{"key":"abc"}}', json: () => ({ success: true, data: { key: 'abc' } }) };
    if (url === 'https://www.cun.ai/api/user/self') throw new Error('self should not be called when callback returned user id');
    throw new Error(`unexpected ${url}`);
  };
  const result = await runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport });
  assert.equal(result.userId, '9202');
  assert.equal(result.keys[0].apiKey, 'sk-abc');
});

test('runSiteOAuthHttp includes token key response diagnostics when key fetch fails', async () => {
  const transport = async (url, opts) => {
    if (url === 'https://www.cun.ai/sign-in') return { status: 200, headers: {}, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/state?aff=') return { status: 200, headers: {}, text: () => '{"data":"STATE123"}', json: () => ({ data: 'STATE123' }) };
    if (url.startsWith('https://github.com/login/oauth/authorize?')) return { status: 302, headers: { location: 'https://www.cun.ai/oauth/github?code=C&state=STATE123' }, text: () => '', json: () => null };
    if (url === 'https://www.cun.ai/api/oauth/github?code=C&state=STATE123') return { status: 200, headers: {}, text: () => '{"success":true,"data":{"id":42}}', json: () => ({ success: true, data: { id: 42 } }) };
    if (url === 'https://www.cun.ai/api/token/') return { status: 200, headers: {}, text: () => '{"success":true}', json: () => ({ success: true }) };
    if (url === 'https://www.cun.ai/api/token/?p=1&size=20') return { status: 200, headers: {}, text: () => '{"data":{"items":[{"id":7,"created_time":1}]}}', json: () => ({ data: { items: [{ id: 7, created_time: 1 }] } }) };
    if (url === 'https://www.cun.ai/api/token/7/key') return { status: 404, headers: {}, text: () => 'not found', json: () => null };
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(
    () => runSiteOAuthHttp({ name: 'cun.ai', baseUrl: 'https://www.cun.ai', clientId: 'CLIENT' }, [], { transport }),
    /token key fetch failed status=404 body=not found/
  );
});
