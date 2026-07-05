const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultCookieFile,
  defaultCookieDir,
  shouldDeleteGithubCookies,
  listCookieFiles,
  loadCookies,
  deleteCookieFile,
  saveGithubSession,
  saveCookies,
} = require('../lib/cookie-store');

test('cookie store lists explicit, queued, and legacy cookies once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-store-'));
  const dir = path.join(root, 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const explicit = path.join(root, 'explicit.json');
  const first = path.join(dir, '001.json');
  const second = path.join(dir, '002.json');
  const legacy = defaultCookieFile(root);
  saveCookies(explicit, [{ name: 'a', value: '1' }]);
  saveCookies(first, [{ name: 'b', value: '2' }]);
  saveCookies(second, [{ name: 'c', value: '3' }]);
  saveCookies(legacy, [{ name: 'd', value: '4' }]);

  assert.deepEqual(listCookieFiles({ rootDir: root, file: explicit, dir }), [
    path.resolve(explicit),
    path.resolve(first),
    path.resolve(second),
    path.resolve(legacy),
  ]);
});

test('cookie store loads and deletes a cookie file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-store-'));
  const file = path.join(root, 'cookies.json');
  saveCookies(file, [{ name: 'user_session', value: 'abc', domain: '.github.com', path: '/' }]);

  assert.equal(loadCookies(file)[0].name, 'user_session');
  assert.equal(deleteCookieFile(file), true);
  assert.equal(fs.existsSync(file), false);
});

test('shouldDeleteGithubCookies keeps sessions by default', () => {
  assert.equal(shouldDeleteGithubCookies({}), false);
  assert.equal(shouldDeleteGithubCookies({ DELETE_GITHUB_COOKIES_AFTER_USE: 'true' }), true);
  assert.equal(shouldDeleteGithubCookies({ KEEP_GITHUB_COOKIES: 'false' }), true);
});

test('saveGithubSession writes explicit file and persistent session archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-store-'));
  const explicit = path.join(root, 'one-shot.json');
  const saved = saveGithubSession({
    cookies: [{ name: 'user_session', value: 'abc', domain: '.github.com', path: '/' }],
    rootDir: root,
    file: explicit,
    username: 'nsnzd-user',
    now: new Date('2026-07-06T12:34:56Z'),
  });

  assert.equal(saved.primary, explicit);
  assert.equal(fs.existsSync(explicit), true);
  assert.equal(saved.archive, path.join(defaultCookieDir(root), '20260706123456-nsnzd-user.json'));
  assert.equal(loadCookies(saved.archive)[0].name, 'user_session');
});
