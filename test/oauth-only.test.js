const test = require('node:test');
const assert = require('node:assert/strict');
const { runQueuedOrFresh } = require('../oauth-only');

test('oauth queue deletes a successful cookie and does not register a fresh account', async () => {
  const deleted = [];
  let freshCalled = false;

  const result = await runQueuedOrFresh({
    log: false,
    cookieFiles: ['/tmp/github-cookie-a.json'],
    runWithCookieFile: async (file) => ({ success: true, source: 'cookies', cookieFile: file, keys: [] }),
    runFreshRegistration: async () => {
      freshCalled = true;
      throw new Error('fresh should not run');
    },
    deleteCookieFile: (file) => {
      deleted.push(file);
      return true;
    },
  });

  assert.equal(result.cookieFile, '/tmp/github-cookie-a.json');
  assert.deepEqual(deleted, ['/tmp/github-cookie-a.json']);
  assert.equal(freshCalled, false);
});

test('oauth queue deletes a failed cookie and tries the next cookie', async () => {
  const deleted = [];
  const attempted = [];

  const result = await runQueuedOrFresh({
    log: false,
    cookieFiles: ['/tmp/github-cookie-a.json', '/tmp/github-cookie-b.json'],
    runWithCookieFile: async (file) => {
      attempted.push(file);
      if (file.endsWith('-a.json')) throw new Error('expired cookie');
      return { success: true, source: 'cookies', cookieFile: file, keys: [] };
    },
    runFreshRegistration: async () => {
      throw new Error('fresh should not run');
    },
    deleteCookieFile: (file) => {
      deleted.push(file);
      return true;
    },
  });

  assert.equal(result.cookieFile, '/tmp/github-cookie-b.json');
  assert.deepEqual(attempted, ['/tmp/github-cookie-a.json', '/tmp/github-cookie-b.json']);
  assert.deepEqual(deleted, ['/tmp/github-cookie-a.json', '/tmp/github-cookie-b.json']);
});

test('oauth queue runs fresh registration when no cookies are available', async () => {
  let freshCalled = false;

  const result = await runQueuedOrFresh({
    log: false,
    cookieFiles: [],
    runWithCookieFile: async () => {
      throw new Error('cookie should not run');
    },
    runFreshRegistration: async () => {
      freshCalled = true;
      return { success: true, source: 'fresh-registration', keys: [] };
    },
  });

  assert.equal(freshCalled, true);
  assert.equal(result.source, 'fresh-registration');
});
