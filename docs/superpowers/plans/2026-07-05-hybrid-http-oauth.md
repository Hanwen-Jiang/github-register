# Hybrid HTTP OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep GitHub signup in Playwright while moving GitHub OAuth and target-site token creation to HTTP requests.

**Architecture:** Add a reusable HTTP client with cookie import/export support, then add a hybrid OAuth module that consumes Playwright cookies and performs each target site's OAuth + token lifecycle through HTTP. Modify `index.js` so Phase 5 calls the HTTP module after GitHub login instead of navigating the browser through every target site.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, existing `socks-agent.js` for SOCKS requests, Playwright cookie export.

---

### Task 1: HTTP Client Cookie Layer

**Files:**
- Create: `/Users/haven/Documents/code/github-register/lib/http-client.js`
- Test: `/Users/haven/Documents/code/github-register/test/http-client.test.js`

- [ ] **Step 1: Write failing tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { CookieJar } = require('../lib/http-client');

test('CookieJar imports Playwright cookies and scopes them by request host', () => {
  const jar = new CookieJar();
  jar.importPlaywrightCookies([
    { name: '_gh_sess', value: 'abc', domain: '.github.com', path: '/' },
    { name: 'session', value: 'site', domain: 'www.cun.ai', path: '/' },
    { name: 'session', value: 'api', domain: 'a6api.com', path: '/' },
  ]);
  assert.equal(jar.getCookieHeader('https://github.com/login/oauth/authorize'), '_gh_sess=abc');
  assert.equal(jar.getCookieHeader('https://www.cun.ai/api/user/self'), 'session=site');
  assert.equal(jar.getCookieHeader('https://a6api.com/api/user/self'), 'session=api');
});

test('CookieJar stores multiple Set-Cookie headers without merging domains incorrectly', () => {
  const jar = new CookieJar();
  jar.storeFromHeaders('https://www.cun.ai/sign-in', {
    'set-cookie': [
      'session=one; Path=/; Domain=www.cun.ai; HttpOnly',
      'other=two; Path=/; HttpOnly',
    ],
  });
  assert.equal(jar.getCookieHeader('https://www.cun.ai/keys'), 'session=one; other=two');
  assert.equal(jar.getCookieHeader('https://a6api.com/keys'), '');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test test/http-client.test.js`
Expected: FAIL because `../lib/http-client` does not exist yet.

- [ ] **Step 3: Implement minimal HTTP client cookie layer**

Create `CookieJar` with `importPlaywrightCookies()`, `storeFromHeaders()`, and `getCookieHeader()`.

- [ ] **Step 4: Run tests and verify pass**

Run: `node --test test/http-client.test.js`
Expected: PASS.

### Task 2: HTTP Request Wrapper

**Files:**
- Modify: `/Users/haven/Documents/code/github-register/lib/http-client.js`
- Test: `/Users/haven/Documents/code/github-register/test/http-client.test.js`

- [ ] **Step 1: Write failing tests**

Add a test that injects a fake transport and verifies headers, form body, JSON body, and redirect locations are returned without doing network I/O.

- [ ] **Step 2: Run tests and verify fail**

Run: `node --test test/http-client.test.js`
Expected: FAIL because `HttpClient` is missing.

- [ ] **Step 3: Implement minimal `HttpClient`**

Expose `request()`, `get()`, `postForm()`, and `postJson()`. Use injected transport in tests and existing `socksRequest()` by default.

- [ ] **Step 4: Run tests and verify pass**

Run: `node --test test/http-client.test.js`
Expected: PASS.

### Task 3: Hybrid OAuth Module

**Files:**
- Create: `/Users/haven/Documents/code/github-register/lib/hybrid-oauth.js`
- Test: `/Users/haven/Documents/code/github-register/test/hybrid-oauth.test.js`

- [ ] **Step 1: Write failing tests**

Test that `runSiteOAuthHttp()` performs: target sign-in, oauth state, GitHub authorize GET, authorize POST, callback follow, self lookup, token create, token list, token key.

- [ ] **Step 2: Run tests and verify fail**

Run: `node --test test/hybrid-oauth.test.js`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement minimal module**

Implement `runSiteOAuthHttp(site, githubCookies, opts)` and `runSitesOAuthHttp(sites, githubCookies, opts)`.

- [ ] **Step 4: Run tests and verify pass**

Run: `node --test test/hybrid-oauth.test.js`
Expected: PASS.

### Task 4: Wire Hybrid Mode into Main Flow

**Files:**
- Modify: `/Users/haven/Documents/code/github-register/index.js`
- Modify: `/Users/haven/Documents/code/github-register/package.json`

- [ ] **Step 1: Add script test command**

Add `"test": "node --test"` to package scripts.

- [ ] **Step 2: Replace Phase 5 browser OAuth path**

After GitHub login is confirmed, export `await context.cookies()` and pass cookies to `runSitesOAuthHttp(TARGET_SITES, cookies)`.

- [ ] **Step 3: Keep fallback controlled by env**

Use `HYBRID_HTTP_OAUTH !== 'false'` as default-on. If set to false, keep existing browser Phase 5 path.

- [ ] **Step 4: Run full tests**

Run: `npm test`
Expected: PASS.
