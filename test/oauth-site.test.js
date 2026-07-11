const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/session-store');
const oauthSite = require('../oauth-site');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauthsite-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

function seedSession(rootDir, over = {}) {
  return store.appendSession({
    email: 'seed@nsnzd.com', username: 'nsnzd-seed', password: 'pw',
    proxy_url: 'socks5://u:pw@h:1',
    storage_state: { cookies: [{ name: 'user_session', value: 'abc', domain: 'github.com', path: '/' }], origins: [] },
    sites_registered: { 'cun.ai': { user_id: '1', keys: [{ apiKey: 'sk-existing' }], account_id: 7 } },
    status: 'active', last_result_keys: 1, empty_keys: false,
    ...over,
  }, { file: path.join(rootDir, 'data', 'sessions.jsonl') });
}

test('Stage B: reuses a session for a new site, mints keys, records + uploads (no browser)', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir); // already on cun.ai → eligible lead for a6api

  const uploads = [];
  const fakeOAuth = async (sites, cookies) => {
    // Prove the stored cookies reach the OAuth engine.
    assert.equal(cookies[0].name, 'user_session');
    return sites.map(s => ({ site: s.name, baseUrl: s.baseUrl, userId: '42', apiKey: 'sk-new-1', profile: 'dynamic-cheap' }));
  };

  const out = await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    runSitesOAuthHttp: fakeOAuth,
    uploadResult: async (r, meta) => { uploads.push({ r, meta }); },
    importToApi: false,
    routingProfiles: [{ name: 'dynamic-cheap' }],
  });

  assert.equal(out.success, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].apiKey, 'sk-new-1');

  // Session now records a6api with the new key.
  const sess = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.ok(sess.sites_registered['a6api'], 'a6api should be recorded');
  assert.equal(sess.sites_registered['a6api'].keys[0].apiKey, 'sk-new-1');
  assert.equal(sess.sites_registered['cun.ai'].keys[0].apiKey, 'sk-existing'); // preserved

  // Upload carries keys, NOT storage_state.
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].r.source, 'stage-b-oauth');
  assert.equal(uploads[0].r.keys[0].apiKey, 'sk-new-1');
  assert.ok(!('storage_state' in uploads[0].r), 'must not upload storage_state');
});

test('Stage B: --email targets a specific session and skips already-registered sites', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir); // on cun.ai already

  let oauthCalls = 0;
  const out = await oauthSite.main({
    args: { email: 'seed@nsnzd.com', site: 'cun.ai' }, // cun.ai already registered → should skip
    rootDir,
    runSitesOAuthHttp: async () => { oauthCalls++; return []; },
    uploadResult: async () => {},
    importToApi: false,
  });
  assert.equal(oauthCalls, 0, 'should not OAuth a site already registered');
  assert.equal(out.results.length, 0);
});

test('Stage B: OAuth failure records last_error and continues', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir);
  const out = await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    runSitesOAuthHttp: async () => { throw new Error('oauth boom'); },
    uploadResult: async () => {},
    importToApi: false,
  });
  assert.equal(out.success, false);
  const sess = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.match(sess.last_error, /oauth boom/);
});

test('Stage B marks a session unusable when GitHub redirects OAuth to login', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir, { sites_registered: {}, last_result_keys: 0, empty_keys: true });

  const out = await oauthSite.main({
    args: { email: '', site: 'cun.ai' },
    rootDir,
    runSitesOAuthHttp: async () => {
      throw new Error('all sites failed: cun.ai: unable to fetch user id status=401 trace=site_signin:200 | site_state:200 | github_authorize_get:302->https://github.com/login?client_id=X');
    },
    uploadResult: async () => {},
    importToApi: false,
  });

  assert.equal(out.success, false);
  const sess = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.equal(sess.status, 'github_login_required');
  assert.match(sess.last_error, /github_authorize_get:302/);
});

test('Stage B quarantines suspended GitHub accounts separately', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir, { sites_registered: {}, last_result_keys: 0, empty_keys: true });

  const out = await oauthSite.main({
    args: { email: '', site: 'cun.ai' },
    rootDir,
    runSitesOAuthHttp: async () => {
      throw new Error('all sites failed: cun.ai: github_authorize_get:200 body=Account suspended');
    },
    uploadResult: async () => {},
    importToApi: false,
  });

  assert.equal(out.success, false);
  const sess = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.equal(sess.status, 'github_suspended');
  assert.match(sess.last_error, /Account suspended/);
  assert.ok(sess.suspended_at);

  const isolated = store.listSuspendedSessions({ rootDir });
  assert.equal(isolated.length, 1);
  assert.equal(isolated[0].email, 'seed@nsnzd.com');
  assert.equal(isolated[0].status, 'github_suspended');
});

test('Stage B skips remaining sites for a session after it becomes login-required', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir, { sites_registered: {}, last_result_keys: 0, empty_keys: true });

  const calledSites = [];
  const out = await oauthSite.main({
    args: { email: '', site: '' },
    rootDir,
    sitesLib: {
      resolveTargetSites: () => [
        { name: 'cun.ai', baseUrl: 'https://www.cun.ai' },
        { name: 'a6api', baseUrl: 'https://a6api.com' },
      ],
      resolveRoutingProfiles: () => [{ name: 'dynamic-cheap' }],
    },
    runSitesOAuthHttp: async (sites) => {
      calledSites.push(sites[0].name);
      throw new Error('all sites failed: cun.ai: unable to fetch user id status=401 trace=github_authorize_get:302->https://github.com/login?client_id=X');
    },
    uploadResult: async () => {},
    importToApi: false,
  });

  assert.equal(out.success, false);
  assert.deepEqual(calledSites, ['cun.ai']);
  const sess = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.equal(sess.status, 'github_login_required');
});

test('acquireSessionSiteLock clears a lock whose recorded pid is dead', () => {
  const rootDir = tmpRoot();
  const session = { email: 'seed@nsnzd.com' };
  const site = { name: 'xyc.ai' };
  const file = oauthSite.sessionSiteLockPath(rootDir, session.email, site.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ email: session.email, site: site.name, pid: 999999, created_at: new Date().toISOString() }));

  const lock = oauthSite.acquireSessionSiteLock(session, site, {
    rootDir,
    staleMs: 30 * 60 * 1000,
    isPidAlive: () => false,
  });

  try {
    assert.equal(lock.acquired, true);
    assert.equal(fs.existsSync(file), true);
  } finally {
    oauthSite.releaseSessionSiteLock(lock);
  }
});

test('Stage B does not run the same session-site pair twice concurrently', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir);

  let oauthCalls = 0;
  let firstEntered;
  const firstEnteredPromise = new Promise(resolve => { firstEntered = resolve; });
  let releaseFirst;
  const releaseFirstPromise = new Promise(resolve => { releaseFirst = resolve; });

  const fakeOAuth = async (sites) => {
    oauthCalls += 1;
    if (oauthCalls === 1) {
      firstEntered();
      await releaseFirstPromise;
    }
    return sites.map(s => ({ site: s.name, baseUrl: s.baseUrl, userId: '42', apiKey: `sk-new-${oauthCalls}`, profile: 'dynamic-cheap' }));
  };

  const opts = {
    args: { email: '', site: 'a6api' },
    rootDir,
    runSitesOAuthHttp: fakeOAuth,
    uploadResult: async () => {},
    importToApi: false,
    routingProfiles: [{ name: 'dynamic-cheap' }],
  };

  const first = oauthSite.main(opts);
  await firstEnteredPromise;
  const second = oauthSite.main(opts);
  await new Promise(resolve => setImmediate(resolve));
  releaseFirst();

  const [firstOut, secondOut] = await Promise.all([first, second]);

  assert.equal(oauthCalls, 1, 'second worker must not enter OAuth for an already-running session-site pair');
  assert.equal(firstOut.success, true);
  assert.equal(secondOut.success, false);
});

test('planWork picks a reusable session per target site', () => {
  const rootDir = tmpRoot();
  seedSession(rootDir);
  const plan = oauthSite.__planWorkForTest
    ? oauthSite.__planWorkForTest()
    : require('../oauth-site').planWork(
        [{ name: 'a6api', baseUrl: 'https://a6api.com' }],
        { email: '', site: '' },
        { findSession: store.findSession, findReusableSession: store.findReusableSession, rootDir },
      );
  assert.equal(plan.length, 1);
  assert.equal(plan[0].site.name, 'a6api');
  assert.equal(plan[0].session.email, 'seed@nsnzd.com');
});

test('planWork falls back to active GitHub-only sessions when no lead exists', () => {
  const rootDir = tmpRoot();
  store.appendSession({
    email: 'fresh@nsnzd.com',
    username: 'nsnzd-fresh',
    password: 'pw',
    proxy_url: 'socks5://u:pw@h:1',
    storage_state: { cookies: [{ name: 'user_session', value: 'abc', domain: '.github.com', path: '/' }], origins: [] },
    sites_registered: {},
    status: 'active',
    last_result_keys: 0,
    empty_keys: true,
  }, { file: path.join(rootDir, 'data', 'sessions.jsonl') });

  const plan = oauthSite.planWork(
    [{ name: 'cun.ai', baseUrl: 'https://www.cun.ai' }],
    { email: '', site: '' },
    {
      findSession: store.findSession,
      findReusableSession: store.findReusableSession,
      findAvailableSession: store.findAvailableSession,
      rootDir,
    },
  );

  assert.equal(plan.length, 1);
  assert.equal(plan[0].site.name, 'cun.ai');
  assert.equal(plan[0].session.email, 'fresh@nsnzd.com');
});

test('Stage B imports local results into api.nsnzd.com when enabled', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir);

  const imports = [];
  const out = await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    apiAdminKey: 'admin-test',
    resolveUploadGroupFn: async () => ({ id: 1, name: 'default' }),
    runSitesOAuthHttp: async (sites) => (
      sites.map(s => ({ site: s.name, baseUrl: s.baseUrl, userId: '42', apiKey: 'sk-new-1', profile: 'dynamic-cheap' }))
    ),
    uploadResult: async () => ({ localFile: path.join(rootDir, 'data', 'results.jsonl') }),
    reuploadUnuploaded: async (opts) => {
      imports.push(opts);
      return { attempted: 1, succeeded: 1, failed: 0 };
    },
    routingProfiles: [{ name: 'dynamic-cheap' }],
  });

  assert.equal(out.success, true);
  assert.equal(out.apiImport.succeeded, 1);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].resultsFile, path.join(rootDir, 'data', 'results.jsonl'));
  assert.equal(imports[0].ledgerFile, path.join(rootDir, 'data', 'uploaded.jsonl'));
  assert.equal(imports[0].adminKey, 'admin-test');
});

test('Stage B resolves upload group before starting OAuth when API import is enabled', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir);

  const order = [];
  const imports = [];
  const out = await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    apiAdminKey: 'admin-test',
    resolveUploadGroupFn: async () => {
      order.push('group');
      return { id: 9, name: 'Claude 渠道' };
    },
    runSitesOAuthHttp: async (sites) => {
      order.push('oauth');
      return sites.map(s => ({ site: s.name, baseUrl: s.baseUrl, userId: '42', apiKey: 'sk-new-1', profile: 'dynamic-cheap' }));
    },
    uploadResult: async () => ({ localFile: path.join(rootDir, 'data', 'results.jsonl') }),
    reuploadUnuploaded: async (opts) => {
      imports.push(opts);
      return { attempted: 1, succeeded: 1, failed: 0 };
    },
    routingProfiles: [{ name: 'dynamic-cheap' }],
  });

  assert.equal(out.success, true);
  assert.deepEqual(order, ['group', 'oauth']);
  assert.equal(imports[0].groupId, 9);
  assert.equal(imports[0].groupName, 'Claude 渠道');
  assert.equal(imports[0].promptGroup, false);
});

test('Stage B ignores stale localhost bridge proxy when running HTTP OAuth', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir, { proxy_url: 'socks5://127.0.0.1:2080' });

  const proxyUrls = [];
  const out = await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    runSitesOAuthHttp: async (sites, _cookies, opts) => {
      proxyUrls.push(opts.proxyUrl);
      return sites.map(s => ({ site: s.name, baseUrl: s.baseUrl, userId: '42', apiKey: 'sk-new-1', profile: 'dynamic-cheap' }));
    },
    uploadResult: async () => ({ localFile: path.join(rootDir, 'data', 'results.jsonl') }),
    importToApi: false,
    routingProfiles: [{ name: 'dynamic-cheap' }],
  });

  assert.equal(out.success, true);
  assert.deepEqual(proxyUrls, [process.env.OAUTH_SITE_PROXY || '']);
});

test('resolveSessionProxyUrl uses explicit OAUTH_SITE_PROXY before stored session proxy', () => {
  const proxy = oauthSite.resolveSessionProxyUrl(
    {
      proxy_url: 'socks5://127.0.0.1:2080',
      upstream_proxy_url: 'socks5://127.0.0.1:2080',
    },
    {
      OAUTH_SITE_PROXY: 'socks5://127.0.0.1:7890',
      PROXY: '',
    },
  );

  assert.equal(proxy, 'socks5://127.0.0.1:7890');
});

test('resolveSessionProxyUrl allows explicit local PROXY when no OAuth-specific proxy is set', () => {
  const proxy = oauthSite.resolveSessionProxyUrl(
    {
      proxy_url: 'socks5://127.0.0.1:2080',
      upstream_proxy_url: 'socks5://127.0.0.1:2080',
    },
    {
      PROXY: 'socks5://127.0.0.1:7890',
    },
  );

  assert.equal(proxy, 'socks5://127.0.0.1:7890');
});

test('Stage B prefers original upstream proxy over browser bridge proxy', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir, {
    proxy_url: 'socks5://127.0.0.1:2080',
    upstream_proxy_url: 'socks5://real:pw@proxy.example:10000',
  });

  const proxyUrls = [];
  await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    runSitesOAuthHttp: async (sites, _cookies, opts) => {
      proxyUrls.push(opts.proxyUrl);
      return sites.map(s => ({ site: s.name, baseUrl: s.baseUrl, userId: '42', apiKey: 'sk-new-1', profile: 'dynamic-cheap' }));
    },
    uploadResult: async () => ({ localFile: path.join(rootDir, 'data', 'results.jsonl') }),
    importToApi: false,
    routingProfiles: [{ name: 'dynamic-cheap' }],
  });

  assert.deepEqual(proxyUrls, ['socks5://real:pw@proxy.example:10000']);
});

test('Stage B forwards persisted per-site group selections and does not pass global routing profiles', async () => {
  const rootDir = tmpRoot();
  seedSession(rootDir);
  const selected = [{ value: 'default', label: '默认分组', source: 'live' }];
  let captured = null;

  const out = await oauthSite.main({
    args: { email: '', site: 'a6api' },
    rootDir,
    siteGroupSelections: { a6api: selected },
    routingProfiles: [{ name: 'dynamic-cheap' }],
    runSitesOAuthHttp: async (sites, _cookies, opts) => {
      captured = opts;
      return sites.map(site => ({ site: site.name, baseUrl: site.baseUrl, userId: '42', apiKey: 'sk-default', profile: null, group: 'default', groupSource: 'live' }));
    },
    uploadResult: async () => ({}),
    importToApi: false,
  });

  assert.equal(out.success, true);
  assert.deepEqual(captured.siteGroupSelections, { a6api: selected });
  assert.equal(captured.routingProfiles, undefined);
});
