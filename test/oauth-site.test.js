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
  });
  assert.equal(out.success, false);
  const sess = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.match(sess.last_error, /oauth boom/);
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
