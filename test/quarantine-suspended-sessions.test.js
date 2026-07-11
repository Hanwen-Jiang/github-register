const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/session-store');
const quarantine = require('../quarantine-suspended-sessions');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-suspended-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

function append(rootDir, over = {}) {
  return store.appendSession({
    email: over.email || 'seed@nsnzd.com',
    username: over.username || 'seed',
    password: 'pw',
    status: over.status || 'active',
    storage_state: { cookies: [], origins: [] },
    sites_registered: {},
    last_result_keys: 0,
    empty_keys: true,
    last_error: over.last_error || null,
  }, { rootDir });
}

test('isolateSuspendedSessions quarantines latest records whose last_error says Account suspended', () => {
  const rootDir = tmpRoot();
  append(rootDir, { email: 'suspended@nsnzd.com', last_error: 'GitHub says Account suspended' });
  append(rootDir, { email: 'ok@nsnzd.com', last_error: 'temporary network error' });

  const out = quarantine.isolateSuspendedSessions({ rootDir, log: false });

  assert.deepEqual(out, {
    scanned: 2,
    matched: 1,
    quarantined: 1,
    copied: 0,
    dryRun: false,
    suspendedFile: path.join(rootDir, 'data', 'sessions.suspended.jsonl'),
  });
  assert.equal(store.findSession('suspended@nsnzd.com', { rootDir }).status, 'github_suspended');
  assert.equal(store.findSession('ok@nsnzd.com', { rootDir }).status, 'active');
  assert.equal(store.listSuspendedSessions({ rootDir }).length, 1);
});

test('isolateSuspendedSessions copies already-marked suspended records into isolated file', () => {
  const rootDir = tmpRoot();
  append(rootDir, { email: 'already@nsnzd.com', status: 'github_suspended', last_error: 'Account suspended' });

  const out = quarantine.isolateSuspendedSessions({ rootDir, log: false });

  assert.equal(out.matched, 1);
  assert.equal(out.quarantined, 0);
  assert.equal(out.copied, 1);
  assert.equal(store.listSuspendedSessions({ rootDir }).length, 1);
});

test('isolateSuspendedSessions can force-quarantine a specific email', () => {
  const rootDir = tmpRoot();
  append(rootDir, { email: 'manual@nsnzd.com', last_error: null });

  const out = quarantine.isolateSuspendedSessions({ rootDir, email: 'manual@nsnzd.com', log: false });

  assert.equal(out.matched, 1);
  assert.equal(out.quarantined, 1);
  assert.equal(store.findSession('manual@nsnzd.com', { rootDir }).status, 'github_suspended');
  assert.equal(store.listSuspendedSessions({ rootDir })[0].email, 'manual@nsnzd.com');
});
