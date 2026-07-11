const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/session-store');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  return { file: path.join(dir, 'sessions.jsonl') };
}

function baseRecord(over = {}) {
  return {
    email: 'a@nsnzd.com', username: 'nsnzd-a1', password: 'p',
    proxy_url: 'socks5://u:pw@h:1', storage_state: { cookies: [{ name: 'x', value: '1' }], origins: [] },
    sites_registered: {}, status: 'active', last_result_keys: 1, empty_keys: false,
    ...over,
  };
}

test('appendSession writes one line with schema/timestamps filled', () => {
  const o = tmp();
  const rec = store.appendSession({ email: 'a@nsnzd.com', username: 'nsnzd-a1' }, o);
  assert.equal(rec.schema_version, store.SCHEMA_VERSION);
  assert.ok(rec.created_at && rec.last_used_at);
  assert.equal(store.listSessions(o).length, 1);
});

test('appendSession requires email', () => {
  const o = tmp();
  assert.throws(() => store.appendSession({ username: 'x' }, o), /email is required/);
});

test('listSessions skips blank and corrupt lines', () => {
  const o = tmp();
  fs.writeFileSync(o.file, [
    JSON.stringify(baseRecord()),
    '', 'not-json{',
    JSON.stringify(baseRecord({ email: 'b@nsnzd.com' })),
  ].join('\n'));
  const list = store.listSessions({ ...o, quiet: true });
  assert.deepEqual(list.map(r => r.email).sort(), ['a@nsnzd.com', 'b@nsnzd.com']);
});

test('findSession is last-wins across duplicate email lines (append-only updates)', () => {
  const o = tmp();
  store.appendSession(baseRecord({ status: 'active' }), o);
  store.appendSession(baseRecord({ status: 'exhausted' }), o); // later line wins
  assert.equal(store.findSession('a@nsnzd.com', o).status, 'exhausted');
  // listSessions collapses to one record per email
  assert.equal(store.listSessions(o).length, 1);
});

test('updateSession appends a merged line and deep-merges sites_registered', () => {
  const o = tmp();
  store.appendSession(baseRecord({
    sites_registered: { 'cun.ai': { user_id: '9', keys: [{ apiKey: 'sk-1' }], account_id: null } },
  }), o);
  store.updateSession('a@nsnzd.com', {
    sites_registered: { a6api: { user_id: '3', keys: [{ apiKey: 'sk-2' }] } },
  }, o);
  const rec = store.findSession('a@nsnzd.com', o);
  assert.deepEqual(Object.keys(rec.sites_registered).sort(), ['a6api', 'cun.ai']); // both preserved
  // raw file has 2 lines (append-only); logical view has 1
  assert.equal(store.listSessionsRaw(o).length, 2);
  assert.equal(store.listSessions(o).length, 1);
});

test('updateSession throws when email missing unless upsert', () => {
  const o = tmp();
  assert.throws(() => store.updateSession('missing@x', { status: 'active' }, o), /no session/);
  const rec = store.updateSession('new@nsnzd.com', { username: 'nsnzd-n', status: 'active' }, { ...o, upsert: true });
  assert.equal(rec.email, 'new@nsnzd.com');
});

test('markSiteRegistered recomputes last_result_keys/empty_keys', () => {
  const o = tmp();
  store.appendSession(baseRecord({ sites_registered: {}, last_result_keys: 0, empty_keys: true }), o);
  store.markSiteRegistered('a@nsnzd.com', 'cun.ai', { userId: '9', keys: [{ apiKey: 'sk-1' }, { apiKey: 'sk-2' }] }, o);
  const rec = store.findSession('a@nsnzd.com', o);
  assert.equal(rec.last_result_keys, 2);
  assert.equal(rec.empty_keys, false);
  assert.equal(rec.sites_registered['cun.ai'].user_id, '9');
});

test('getSessionCookies returns the storage_state.cookies array', () => {
  const rec = baseRecord();
  const cookies = store.getSessionCookies(rec);
  assert.equal(cookies[0].name, 'x');
  assert.deepEqual(store.getSessionCookies({}), []);
});

// ── findReusableSession: table-driven, mirrors Python find_reusable_session ──
test('findReusableSession excludes ineligible and picks oldest eligible', () => {
  const o = tmp();
  const allowed = ['socks5://u:pw@h:1'];
  // eligible (older)
  store.appendSession(baseRecord({
    email: 'old@nsnzd.com', created_at: '2026-07-01T00:00:00Z', last_used_at: '2026-07-01T00:00:00Z',
    sites_registered: { 'cun.ai': { account_id: 1, keys: [{ apiKey: 'sk' }] } },
  }), o);
  // eligible (newer) — should NOT be chosen over older
  store.appendSession(baseRecord({
    email: 'new@nsnzd.com', created_at: '2026-07-05T00:00:00Z', last_used_at: '2026-07-05T00:00:00Z',
    sites_registered: { 'cun.ai': { account_id: 2, keys: [{ apiKey: 'sk' }] } },
  }), o);
  // ineligible: not active
  store.appendSession(baseRecord({ email: 'inactive@nsnzd.com', status: 'exhausted' }), o);
  // ineligible: empty_keys
  store.appendSession(baseRecord({ email: 'empty@nsnzd.com', empty_keys: true, last_result_keys: 0 }), o);
  // ineligible: proxy not in allowlist
  store.appendSession(baseRecord({ email: 'badproxy@nsnzd.com', proxy_url: 'socks5://u:pw@evil:9' }), o);
  // ineligible: target site already registered
  store.appendSession(baseRecord({
    email: 'already@nsnzd.com', sites_registered: { a6api: { account_id: 5, keys: [{ apiKey: 'sk' }] } },
  }), o);

  const pick = store.findReusableSession('a6api', { ...o, allowedProxies: allowed });
  assert.ok(pick, 'should find an eligible session');
  assert.equal(pick.email, 'old@nsnzd.com'); // oldest by last_used_at

  // 'already@' registered a6api → excluded for target a6api, but eligible for a different target
  const pickCun = store.findReusableSession('some-future-site', { ...o, allowedProxies: allowed });
  assert.ok(pickCun);
});

test('findReusableSession returns null when none eligible', () => {
  const o = tmp();
  store.appendSession(baseRecord({ email: 'x@nsnzd.com', status: 'exhausted' }), o);
  assert.equal(store.findReusableSession('a6api', o), null);
});

test('findAvailableSession falls back to active GitHub-only sessions', () => {
  const o = tmp();
  store.appendSession(baseRecord({
    email: 'fresh@nsnzd.com',
    storage_state: { cookies: [{ name: 'user_session', value: 'abc', domain: '.github.com', path: '/' }], origins: [] },
    sites_registered: {},
    last_result_keys: 0,
    empty_keys: true,
  }), o);

  const pick = store.findAvailableSession('cun.ai', o);
  assert.ok(pick);
  assert.equal(pick.email, 'fresh@nsnzd.com');
});

test('findAvailableSession prefers reusable lead sessions before empty sessions', () => {
  const o = tmp();
  store.appendSession(baseRecord({
    email: 'fresh@nsnzd.com',
    created_at: '2026-07-01T00:00:00Z',
    last_used_at: '2026-07-01T00:00:00Z',
    sites_registered: {},
    last_result_keys: 0,
    empty_keys: true,
  }), o);
  store.appendSession(baseRecord({
    email: 'lead@nsnzd.com',
    created_at: '2026-07-05T00:00:00Z',
    last_used_at: '2026-07-05T00:00:00Z',
    sites_registered: { 'cun.ai': { account_id: 1, keys: [{ apiKey: 'sk' }] } },
    last_result_keys: 1,
    empty_keys: false,
  }), o);

  const pick = store.findAvailableSession('a6api', o);
  assert.ok(pick);
  assert.equal(pick.email, 'lead@nsnzd.com');
});

test('compactSessions collapses append-only duplicates to latest', () => {
  const o = tmp();
  store.appendSession(baseRecord({ status: 'active' }), o);
  store.updateSession('a@nsnzd.com', { status: 'exhausted' }, o);
  assert.equal(store.listSessionsRaw(o).length, 2);
  const kept = store.compactSessions(o);
  assert.equal(kept, 1);
  assert.equal(store.listSessionsRaw(o).length, 1);
  assert.equal(store.findSession('a@nsnzd.com', o).status, 'exhausted');
});

test('quarantineSuspendedSession marks latest session and writes isolated suspended file', () => {
  const o = tmp();
  store.appendSession(baseRecord({ status: 'active' }), o);

  const out = store.quarantineSuspendedSession('a@nsnzd.com', { last_error: 'Account suspended' }, o);

  assert.equal(out.status, 'github_suspended');
  assert.ok(out.suspended_at);
  assert.equal(store.findSession('a@nsnzd.com', o).status, 'github_suspended');
  const suspended = store.listSuspendedSessions(o);
  assert.equal(suspended.length, 1);
  assert.equal(suspended[0].email, 'a@nsnzd.com');
  assert.equal(suspended[0].last_error, 'Account suspended');
});

test('sessionFile option redirects reads and appends without changing the default store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-custom-'));
  const defaultPath = path.join(dir, 'data', 'sessions.jsonl');
  const customPath = path.join(dir, 'data', 'sessions.rescreened.usable.jsonl');

  store.appendSession(baseRecord({ email: 'default@nsnzd.com' }), { file: defaultPath });
  store.appendSession(baseRecord({ email: 'custom@nsnzd.com' }), { rootDir: dir, sessionFile: customPath });

  assert.deepEqual(store.listSessions({ file: defaultPath }).map(item => item.email), ['default@nsnzd.com']);
  assert.deepEqual(store.listSessions({ rootDir: dir, sessionFile: customPath }).map(item => item.email), ['custom@nsnzd.com']);
});

test('SESSION_STORE_FILE selects the derived usable pool when no explicit file is provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-env-'));
  const customPath = path.join(dir, 'sessions.rescreened.usable.jsonl');
  fs.writeFileSync(customPath, `${JSON.stringify(baseRecord({ email: 'env@nsnzd.com' }))}\n`);
  const previous = process.env.SESSION_STORE_FILE;
  process.env.SESSION_STORE_FILE = customPath;
  try {
    assert.deepEqual(store.listSessions({ rootDir: dir }).map(item => item.email), ['env@nsnzd.com']);
  } finally {
    if (previous === undefined) delete process.env.SESSION_STORE_FILE;
    else process.env.SESSION_STORE_FILE = previous;
  }
});
