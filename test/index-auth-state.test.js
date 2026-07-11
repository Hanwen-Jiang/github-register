const test = require('node:test');
const assert = require('node:assert/strict');
const { isGithubLoggedInUrl, resolveReusableProxyUrl, resolveChromiumExecutablePath } = require('../index');

test('isGithubLoggedInUrl does not treat account_verifications as logged in', () => {
  assert.equal(isGithubLoggedInUrl('https://github.com/account_verifications'), false);
  assert.equal(isGithubLoggedInUrl('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard'), false);
  assert.equal(isGithubLoggedInUrl('https://github.com/dashboard'), true);
  assert.equal(isGithubLoggedInUrl('https://github.com/'), true);
});

test('resolveReusableProxyUrl stores original upstream instead of browser localhost bridge', () => {
  assert.equal(
    resolveReusableProxyUrl({
      proxyUrl: 'socks5://real:pw@proxy.example:10000',
      browserProxyUrl: 'socks5://127.0.0.1:2080',
    }),
    'socks5://real:pw@proxy.example:10000'
  );
  assert.equal(
    resolveReusableProxyUrl({
      proxyUrl: '',
      browserProxyUrl: 'socks5://127.0.0.1:2080',
    }),
    ''
  );
});

test('resolveChromiumExecutablePath prefers explicit path then installed system Chrome', () => {
  const exists = p => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(
    resolveChromiumExecutablePath({
      env: { CHROMIUM_PATH: '/missing/chrome' },
      exists,
    }),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  );
  assert.equal(
    resolveChromiumExecutablePath({
      env: { CHROMIUM_PATH: '/custom/chrome' },
      exists: p => p === '/custom/chrome',
    }),
    '/custom/chrome'
  );
  assert.equal(
    resolveChromiumExecutablePath({
      env: {},
      exists: () => false,
    }),
    ''
  );
});
