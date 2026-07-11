const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/session-store');
const refresh = require('../refresh-github-sessions');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-sessions-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

function append(rootDir, over = {}) {
  return store.appendSession({
    email: over.email || 'seed@nsnzd.com',
    username: over.username || 'seed-user',
    password: over.password === undefined ? 'pw' : over.password,
    status: over.status || 'github_login_required',
    proxy_url: over.proxy_url || '',
    upstream_proxy_url: over.upstream_proxy_url || '',
    storage_state: over.storage_state || { cookies: [], origins: [] },
    sites_registered: over.sites_registered || {},
    last_result_keys: over.last_result_keys ?? 0,
    empty_keys: over.empty_keys ?? true,
    last_error: over.last_error || null,
  }, { file: path.join(rootDir, 'data', 'sessions.jsonl') });
}

test('selectRefreshCandidates picks login-required sessions with credentials', () => {
  const rootDir = tmpRoot();
  append(rootDir, { email: 'bad@nsnzd.com', status: 'github_login_required' });
  append(rootDir, { email: 'active@nsnzd.com', status: 'active' });
  append(rootDir, { email: 'nopw@nsnzd.com', status: 'github_login_required', password: '' });

  const picked = refresh.selectRefreshCandidates({ rootDir, total: 10 });

  assert.deepEqual(picked.map(s => s.email), ['bad@nsnzd.com']);
});

test('refreshSessions updates storage_state and restores active status without dropping site records', async () => {
  const rootDir = tmpRoot();
  append(rootDir, {
    email: 'seed@nsnzd.com',
    status: 'github_login_required',
    sites_registered: { 'cun.ai': { user_id: '1', keys: [{ apiKey: 'sk-old' }] } },
    last_result_keys: 1,
    empty_keys: false,
  });

  const seen = [];
  const out = await refresh.refreshSessions({
    rootDir,
    total: 1,
    log: false,
    refreshOne: async (session) => {
      seen.push(session.email);
      return {
        storageState: { cookies: [{ name: 'user_session', value: 'new', domain: 'github.com', path: '/' }], origins: [] },
        proxyUrl: 'socks5://real:pw@proxy.example:10000',
        browserProxyUrl: '',
      };
    },
  });

  assert.deepEqual(out, { total: 1, ok: 1, failed: 0, attempted: 1, suspended: 0 });
  assert.deepEqual(seen, ['seed@nsnzd.com']);
  const latest = store.findSession('seed@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.equal(latest.status, 'active');
  assert.equal(latest.last_error, null);
  assert.equal(latest.storage_state.cookies[0].value, 'new');
  assert.equal(latest.sites_registered['cun.ai'].keys[0].apiKey, 'sk-old');
  assert.equal(latest.last_result_keys, 1);
  assert.equal(latest.empty_keys, false);
});

test('refreshSessions marks failed login attempts and continues', async () => {
  const rootDir = tmpRoot();
  append(rootDir, { email: 'a@nsnzd.com' });
  append(rootDir, { email: 'b@nsnzd.com' });
  let calls = 0;

  const out = await refresh.refreshSessions({
    rootDir,
    total: 1,
    log: false,
    refreshOne: async () => {
      calls += 1;
      if (calls === 1) throw new Error('github_login_verification_required');
      return { storageState: { cookies: [{ name: 'user_session', value: 'ok', domain: 'github.com', path: '/' }], origins: [] } };
    },
  });

  assert.deepEqual(out, { total: 1, ok: 1, failed: 1, attempted: 2, suspended: 0 });
  assert.equal(store.findSession('a@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') }).status, 'github_login_failed');
  assert.equal(store.findSession('b@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') }).status, 'active');
});

test('refreshSessions quarantines suspended GitHub accounts separately', async () => {
  const rootDir = tmpRoot();
  append(rootDir, { email: 'suspended@nsnzd.com' });

  const out = await refresh.refreshSessions({
    rootDir,
    total: 1,
    log: false,
    refreshOne: async () => {
      throw new Error('Account suspended');
    },
  });

  assert.deepEqual(out, { total: 1, ok: 0, failed: 1, attempted: 1, suspended: 1 });
  const latest = store.findSession('suspended@nsnzd.com', { file: path.join(rootDir, 'data', 'sessions.jsonl') });
  assert.equal(latest.status, 'github_suspended');
  assert.match(latest.last_error, /Account suspended/);
  assert.ok(latest.suspended_at);

  const isolated = store.listSuspendedSessions({ rootDir });
  assert.equal(isolated.length, 1);
  assert.equal(isolated[0].email, 'suspended@nsnzd.com');
  assert.equal(isolated[0].status, 'github_suspended');
});

test('isGithubSuspendedError recognizes GitHub suspended URL redirects', () => {
  assert.equal(refresh.isGithubSuspendedError('github_login_failed_url:https://github.com/account/suspended'), true);
  assert.equal(refresh.isGithubSuspendedError('temporary login failure'), false);
});

test('maybeHandleLoginVerification accepts verified-device pages that mention enabling two-factor auth', async () => {
  let filled = '';
  let clicked = false;
  let clickOptions = null;
  const otp = {
    first() { return this; },
    async isVisible() { return true; },
    async fill(value) { filled = value; },
  };
  const submit = {
    first() { return this; },
    async isVisible() { return true; },
    async click(options) { clicked = true; clickOptions = options; },
  };
  const page = {
    url: () => 'https://github.com/sessions/verified-device',
    locator(selector) {
      if (selector === 'body') {
        return { innerText: async () => 'Device verification\nConsider enabling two-factor authentication on your account.' };
      }
      if (selector.includes('input[name="otp"]')) return otp;
      if (selector.includes('button[type="submit"]')) return submit;
      throw new Error(`unexpected selector: ${selector}`);
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };

  const handled = await refresh.maybeHandleLoginVerification(page, { email: 'seed@example.com' }, {
    pollOTP: async () => '123456',
  });

  assert.equal(handled, true);
  assert.equal(filled, '123456');
  assert.equal(clicked, true);
  assert.deepEqual(clickOptions, { noWaitAfter: true });
});
