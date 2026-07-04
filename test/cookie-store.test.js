const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  defaultCookieFile,
  listCookieFiles,
  loadCookies,
  deleteCookieFile,
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
