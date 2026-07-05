# Lost-Key Fix + Proxy Pool Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop wasting minted keys (produced but never uploaded to api.nsnzd.com), and generate a 100-proxy pool (`jhw001..jhw100`) from a template for the later concurrency scheduler.

**Architecture:** Three isolated additions. (1) `lib/upload-ledger.js` records which minted results reached api.nsnzd.com in a local `data/uploaded.jsonl`, so recovery never depends on the volatile pool API (which masks `api_key` and dropped 106→0 in a day). (2) `lib/proxy-pool.js` template-generates proxies. (3) Minimal edits to `register-upload-api-nsnzd.js` (retry-wrap mint→build→upload, mark ledger on success) and `lib/api-nsnzd-uploader.js` (route `/v1/models` probe through the SOCKS proxy instead of bare `fetch`), plus a new `register-upload-retry.js` entry that re-uploads un-uploaded results.

**Tech Stack:** Node.js CommonJS, `node:test`, existing `socks-agent.js` (`socksRequest`).

## Global Constraints

- Node `>=20`, CommonJS. No new npm dependencies.
- Tests use `node:test` + `node:assert/strict` in `test/`, run via `npm test`. No network/browser in unit tests — inject fakes.
- **Scope amendment:** Phase 1's "do not modify `register-upload-api-nsnzd.js`" is LIFTED for Tasks P2-4 and P2-5 (the lost-key fix requires it). Keep edits minimal and behavior-preserving on the success path.
- "Un-uploaded" detection MUST use the local ledger `data/uploaded.jsonl`, never pool-matching. The list API does not return `credentials.api_key`.
- Stable record id for the ledger = `run id`: prefer `result.source` if present, else `${result.username}|${result.uploaded_at}` — a record's identity that survives re-reading `results.jsonl`.
- Proxy template: `socks5://jhw{NNN}-zone-custom:asdf1476@as.rrp.bestgo.work:10000` where `{NNN}` is the index zero-padded to 3 digits, for index 1..count (default count 100).
- Work on branch `feat/dynamic-pool-watcher` (continues Phase 1).

---

### Task P2-1: Upload ledger — record and query uploaded results

**Files:**
- Create: `lib/upload-ledger.js`
- Test: `test/upload-ledger.test.js`

**Interfaces:**
- Produces:
  - `resultId(result) => string` — stable id: `result.source` if truthy, else `${result.username||''}|${result.uploaded_at||''}`.
  - `markUploaded(result, { ledgerFile }) => void` — appends one JSON line `{ id, username, keyCount, at }` to `ledgerFile` (creating parent dir).
  - `loadUploadedIds(ledgerFile) => Set<string>` — returns the set of ids present in the ledger (empty set if file missing).
  - `findUnuploaded(results, ledgerFile) => Array<result>` — given an array of result objects, returns those whose `resultId` is not in the ledger.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resultId, markUploaded, loadUploadedIds, findUnuploaded } = require('../lib/upload-ledger');

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  return path.join(dir, 'uploaded.jsonl');
}

test('resultId prefers source, falls back to username|uploaded_at', () => {
  assert.equal(resultId({ source: 'run-123' }), 'run-123');
  assert.equal(resultId({ username: 'u1', uploaded_at: 't1' }), 'u1|t1');
});

test('markUploaded then loadUploadedIds round-trips ids', () => {
  const f = tmpLedger();
  markUploaded({ source: 'r1', username: 'u1', keys: [{}, {}] }, { ledgerFile: f });
  markUploaded({ source: 'r2', username: 'u2', keys: [{}] }, { ledgerFile: f });
  const ids = loadUploadedIds(f);
  assert.ok(ids.has('r1'));
  assert.ok(ids.has('r2'));
  assert.equal(ids.size, 2);
});

test('loadUploadedIds returns empty set when file missing', () => {
  assert.equal(loadUploadedIds('/no/such/ledger.jsonl').size, 0);
});

test('findUnuploaded returns only results absent from ledger', () => {
  const f = tmpLedger();
  markUploaded({ source: 'r1' }, { ledgerFile: f });
  const results = [{ source: 'r1' }, { source: 'r2' }, { source: 'r3' }];
  const missing = findUnuploaded(results, f);
  assert.deepEqual(missing.map(r => r.source), ['r2', 'r3']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/upload-ledger.test.js`
Expected: FAIL — `resultId is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/upload-ledger.js
'use strict';
const fs = require('fs');
const path = require('path');

function resultId(result) {
  if (result && result.source) return String(result.source);
  return `${(result && result.username) || ''}|${(result && result.uploaded_at) || ''}`;
}

function markUploaded(result, { ledgerFile }) {
  const line = JSON.stringify({
    id: resultId(result),
    username: (result && result.username) || '',
    keyCount: Array.isArray(result && result.keys) ? result.keys.length : 0,
    at: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${line}\n`);
}

function loadUploadedIds(ledgerFile) {
  const ids = new Set();
  let raw;
  try { raw = fs.readFileSync(ledgerFile, 'utf8'); } catch (_) { return ids; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && o.id) ids.add(String(o.id)); } catch (_) { /* skip */ }
  }
  return ids;
}

function findUnuploaded(results, ledgerFile) {
  const done = loadUploadedIds(ledgerFile);
  return (results || []).filter(r => !done.has(resultId(r)));
}

module.exports = { resultId, markUploaded, loadUploadedIds, findUnuploaded };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/upload-ledger.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/upload-ledger.js test/upload-ledger.test.js
git commit -m "feat(upload-ledger): local ledger of uploaded results"
```

---

### Task P2-2: readAllResults — parse results.jsonl into records

**Files:**
- Modify: `lib/upload-ledger.js`
- Test: `test/upload-ledger-read.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `readAllResults(resultsFile) => Array<object>` — reads a JSONL file, returns parsed objects (skips blank/corrupt lines). Returns `[]` if the file is missing.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAllResults } = require('../lib/upload-ledger');

test('readAllResults parses JSONL and skips bad lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-'));
  const f = path.join(dir, 'results.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ username: 'a', keys: [{ apiKey: 'sk-1' }] }),
    '',
    'not-json',
    JSON.stringify({ username: 'b', keys: [] }),
  ].join('\n'));
  const rows = readAllResults(f);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].username, 'a');
  assert.equal(rows[1].username, 'b');
});

test('readAllResults returns [] when file missing', () => {
  assert.deepEqual(readAllResults('/no/such/results.jsonl'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/upload-ledger-read.test.js`
Expected: FAIL — `readAllResults is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/upload-ledger.js` (export `readAllResults`):

```js
function readAllResults(resultsFile) {
  let raw;
  try { raw = fs.readFileSync(resultsFile, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip */ }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/upload-ledger-read.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/upload-ledger.js test/upload-ledger-read.test.js
git commit -m "feat(upload-ledger): readAllResults JSONL parser"
```

---

### Task P2-3: Proxy pool template generator

**Files:**
- Create: `lib/proxy-pool.js`
- Test: `test/proxy-pool.test.js`

**Interfaces:**
- Produces: `generateProxyPool({ count = 100, password = 'asdf1476', host = 'as.rrp.bestgo.work', port = 10000, userPrefix = 'jhw', pad = 3 } = {}) => string[]` — returns `count` proxy URLs, index 1..count, each `socks5://{userPrefix}{index padded to `pad`}-zone-custom:{password}@{host}:{port}`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateProxyPool } = require('../lib/proxy-pool');

test('generateProxyPool builds count proxies with zero-padded index', () => {
  const pool = generateProxyPool({ count: 100 });
  assert.equal(pool.length, 100);
  assert.equal(pool[0], 'socks5://jhw001-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
  assert.equal(pool[9], 'socks5://jhw010-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
  assert.equal(pool[99], 'socks5://jhw100-zone-custom:asdf1476@as.rrp.bestgo.work:10000');
});

test('generateProxyPool respects custom count and password', () => {
  const pool = generateProxyPool({ count: 3, password: 'pw' });
  assert.deepEqual(pool, [
    'socks5://jhw001-zone-custom:pw@as.rrp.bestgo.work:10000',
    'socks5://jhw002-zone-custom:pw@as.rrp.bestgo.work:10000',
    'socks5://jhw003-zone-custom:pw@as.rrp.bestgo.work:10000',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/proxy-pool.test.js`
Expected: FAIL — `generateProxyPool is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/proxy-pool.js
'use strict';

function generateProxyPool({ count = 100, password = 'asdf1476', host = 'as.rrp.bestgo.work', port = 10000, userPrefix = 'jhw', pad = 3 } = {}) {
  const pool = [];
  for (let i = 1; i <= count; i += 1) {
    const idx = String(i).padStart(pad, '0');
    pool.push(`socks5://${userPrefix}${idx}-zone-custom:${password}@${host}:${port}`);
  }
  return pool;
}

module.exports = { generateProxyPool };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/proxy-pool.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/proxy-pool.js test/proxy-pool.test.js
git commit -m "feat(proxy-pool): template-generate jhwNNN proxy pool"
```

---

### Task P2-4: Route `/v1/models` probe through the SOCKS proxy

**Files:**
- Modify: `lib/api-nsnzd-uploader.js` (function `fetchUpstreamModels`, around line 332)
- Test: `test/api-nsnzd-uploader.test.js` (add a case)

**Interfaces:**
- Consumes: `socksRequest` from `../socks-agent` (existing; `socksRequest(url, { method, headers }) => Promise<{ status, headers, text() }>`). `init(proxyUrl)` must be called before use.
- Produces: `fetchUpstreamModels(key, opts)` unchanged signature, but when `process.env.PROXY` (or `opts.proxy`) is set, the HTTP request goes through the proxy via an injectable `requestImpl`. Default behavior with no proxy is unchanged (bare `fetch`).
- Add an injectable `opts.requestImpl` (defaults to a small adapter): `requestImpl(url, { headers, timeoutMs }) => Promise<{ ok, status, text() }>`.

- [ ] **Step 1: Write the failing test**

```js
// add to test/api-nsnzd-uploader.test.js
test('fetchUpstreamModels uses injected requestImpl (proxy path) and parses ids', async () => {
  const { fetchUpstreamModels } = require('../lib/api-nsnzd-uploader');
  const calls = [];
  const requestImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'claude-opus-4-8' }, { id: 'x' }] }) };
  };
  const ids = await fetchUpstreamModels(
    { apiKey: 'sk-test', baseUrl: 'https://a6api.com', site: 'a6api' },
    { requestImpl, retries: 0 }
  );
  assert.deepEqual(ids, ['claude-opus-4-8', 'x']);
  assert.match(calls[0].url, /\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/api-nsnzd-uploader.test.js`
Expected: FAIL — current `fetchUpstreamModels` ignores `requestImpl` (uses bare `fetch`), so the injected impl is never called / assertions on `calls` fail.

- [ ] **Step 3: Write minimal implementation**

At top of `lib/api-nsnzd-uploader.js`, add: `const { init: initSocks, socksRequest } = require('../socks-agent');`

Add a default adapter and thread `requestImpl` into `fetchUpstreamModels`:

```js
function defaultModelRequest(proxyUrl) {
  if (proxyUrl) {
    initSocks(proxyUrl);
    return async (url, { headers, timeoutMs }) => {
      const resp = await socksRequest(url, { method: 'GET', headers });
      const status = resp.status || 0;
      return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => resp.text() };
    };
  }
  return async (url, { headers, timeoutMs }) => {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs || 30000) });
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, text: async () => resp.text() };
  };
}
```

Then in `fetchUpstreamModels`, replace the bare `fetch` block:

```js
async function fetchUpstreamModels(key, opts = {}) {
  if (!key?.apiKey) throw new Error('missing apiKey in result key');
  if (!key?.baseUrl) throw new Error('missing baseUrl in result key');
  const base = String(key.baseUrl).replace(/\/+$/, '');
  const retries = opts.retries ?? parseInt(process.env.UPSTREAM_MODEL_FETCH_RETRIES || '2', 10);
  const delayMs = opts.retryDelayMs ?? parseInt(process.env.UPSTREAM_MODEL_FETCH_RETRY_DELAY_MS || '1500', 10);
  const proxyUrl = opts.proxy || process.env.PROXY || '';
  const requestImpl = opts.requestImpl || defaultModelRequest(proxyUrl);
  return retryAsync(async () => {
    const resp = await requestImpl(`${base}/v1/models`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key.apiKey}` },
      timeoutMs: opts.timeoutMs || 30000,
    });
    const parsed = await parseApiResponse(resp, { label: `${key.site || base} /v1/models` });
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
    return rows.map(row => typeof row === 'string' ? row : row?.id).filter(Boolean);
  }, { retries, delayMs, onRetry: opts.onRetry });
}
```

NOTE: `parseApiResponse` expects an object with `.ok`, `.status`, `.text()` — the adapter returns exactly that shape, so it stays compatible. Verify `parseApiResponse`'s signature accepts this (it currently calls `resp.text()` and reads `resp.ok`/`resp.status`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/api-nsnzd-uploader.test.js`
Expected: PASS (new test + existing ones).

- [ ] **Step 5: Commit**

```bash
git add lib/api-nsnzd-uploader.js test/api-nsnzd-uploader.test.js
git commit -m "fix(uploader): route /v1/models probe through SOCKS proxy"
```

---

### Task P2-5: Retry-wrap mint→build→upload and mark the ledger

**Files:**
- Modify: `register-upload-api-nsnzd.js` (function `runFullRegisterAndUpload`, ~line 116; add ledger mark on success)
- Test: `test/register-upload-api-nsnzd.test.js` (add a case using injected fakes)

**Interfaces:**
- Consumes: `markUploaded` from `./lib/upload-ledger`.
- Produces: `runFullRegisterAndUpload(opts)` unchanged happy-path return, PLUS: after `uploadAccounts` succeeds, calls `markUploaded(result, { ledgerFile })` where `ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(__dirname, 'data', 'uploaded.jsonl')`. Build+upload are wrapped so a transient failure retries up to `opts.uploadRetries ?? UPLOAD_RETRIES (default 2)` times before throwing.

- [ ] **Step 1: Write the failing test**

```js
// add to test/register-upload-api-nsnzd.test.js
test('runFullRegisterAndUpload marks the ledger after a successful upload', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { runFullRegisterAndUpload } = require('../register-upload-api-nsnzd');
  const { loadUploadedIds } = require('../lib/upload-ledger');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-ledger-'));
  const ledgerFile = path.join(dir, 'uploaded.jsonl');

  const result = { username: 'u-led', uploaded_at: 't-led', source: 'run-led', keys: [{ site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-x' }] };

  await runFullRegisterAndUpload({
    adminKey: 'admin-test',
    groupId: 1,
    registerAndRunSites: async () => result,
    buildAccountsFn: async () => ([{ name: 'n', platform: 'anthropic', type: 'apikey', credentials: { base_url: 'https://a6api.com', api_key: 'sk-x', model_mapping: { 'claude-opus-4-8': 'claude-opus-4-8' } }, concurrency: 1, priority: 1, group_ids: [1] }]),
    uploadFn: async () => ({ success: 1, failed: 0 }),
    ledgerFile,
  });

  const ids = loadUploadedIds(ledgerFile);
  assert.ok(ids.has('run-led'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/register-upload-api-nsnzd.test.js`
Expected: FAIL — `runFullRegisterAndUpload` does not yet accept `buildAccountsFn`/`uploadFn`/`ledgerFile` injection nor write the ledger.

- [ ] **Step 3: Write minimal implementation**

At top of `register-upload-api-nsnzd.js`: `const { markUploaded } = require('./lib/upload-ledger');`

Refactor `runFullRegisterAndUpload` to accept injectable build/upload fns, wrap them in a retry, and mark the ledger:

```js
async function runFullRegisterAndUpload(opts = {}) {
  loadEnv();
  ensureProxyConfigured();
  const adminKey = opts.adminKey || readAdminKey();
  const groupId = opts.groupId || await resolveDefaultGroupId({ adminKey });
  const startedAt = new Date();
  const ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(__dirname, 'data', 'uploaded.jsonl');
  const uploadRetries = opts.uploadRetries ?? parseInt(process.env.UPLOAD_RETRIES || '2', 10);
  const uploadRetryDelayMs = opts.uploadRetryDelayMs ?? parseInt(process.env.UPLOAD_RETRY_DELAY_MS || '2000', 10);

  const result = opts.registerAndRunSites
    ? await opts.registerAndRunSites()
    : (opts.useInProcessRegister || process.env.REGISTER_UPLOAD_IN_PROCESS === 'true')
      ? await getRegisterAndRunSites()()
      : await runRegisterCliAndLoadLatest({ resultFile: opts.resultFile });
  console.log(`[Upload] 读取本次结果: ${result.username || result.email || 'unknown'} / keys=${Array.isArray(result.keys) ? result.keys.length : 0}`);

  const buildAccounts = opts.buildAccountsFn || ((r, o) => buildAnthropicAccountsWithLiveModels(r, o));
  const doUpload = opts.uploadFn || ((accts, o) => uploadAccounts(accts, o));

  const { accounts, upload } = await retryAsync(async () => {
    const accounts = await buildAccounts(result, {
      adminKey, groupIds: [groupId], groupName: 'default', concurrency: 1, priority: 1, date: startedAt,
      onRetry: (err, attempt) => console.log(`[Upload] 模型探测重试 ${attempt}: ${err.message}`),
    });
    console.log(`[Upload] 开始导入 api.nsnzd.com: accounts=${accounts.length}`);
    const upload = await doUpload(accounts, { adminKey });
    return { accounts, upload };
  }, {
    retries: uploadRetries,
    delayMs: uploadRetryDelayMs,
    onRetry: (err, attempt) => console.log(`[Upload] 导入重试 ${attempt}: ${err.message}`),
  });

  markUploaded(result, { ledgerFile });
  console.log(`[Upload] 导入完成并记账: success=${upload?.success ?? 'unknown'} failed=${upload?.failed ?? 'unknown'}`);

  return {
    success: true,
    result,
    imported: accounts.map(account => ({
      name: account.name, platform: account.platform, type: account.type,
      baseUrl: account.credentials.base_url, concurrency: account.concurrency,
      priority: account.priority, groupIds: account.group_ids,
      modelWhitelistCount: Object.keys(account.credentials.model_mapping || {}).length,
    })),
    upload,
  };
}
```

`retryAsync` is ALREADY exported from `./lib/api-nsnzd-uploader` (verified: it is in that file's `module.exports`). Add it to the existing destructured `require('./lib/api-nsnzd-uploader')` at the top of `register-upload-api-nsnzd.js`. No change to the uploader's exports is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/register-upload-api-nsnzd.test.js`
Expected: PASS (new test + existing).
Then `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add register-upload-api-nsnzd.js lib/api-nsnzd-uploader.js test/register-upload-api-nsnzd.test.js
git commit -m "fix(register): retry upload and mark ledger so minted keys are never lost"
```

---

### Task P2-6: `register:upload-retry` entry — re-upload un-uploaded results

**Files:**
- Create: `register-upload-retry.js`
- Modify: `package.json` (add `register:upload-retry` script)
- Test: `test/register-upload-retry.test.js`

**Interfaces:**
- Consumes: `readAllResults`, `findUnuploaded`, `markUploaded` (Tasks P2-1/P2-2); `buildAnthropicAccountsFromResult`, `uploadAccounts`, `resolveDefaultGroupId`, `normalizeAdminKey` from the uploader.
- Produces:
  - `reuploadUnuploaded({ resultsFile, ledgerFile, adminKey, groupId, buildAccountsFn, uploadFn }) => Promise<{ attempted, succeeded, failed }>` — reads results, finds un-uploaded, and for each: builds accounts (using models already implied — reuse `buildAnthropicAccountsWithLiveModels` unless a `buildAccountsFn` is injected), uploads, and marks the ledger on success. Continues past individual failures; returns counts.
  - Entry runs `reuploadUnuploaded` against real defaults when invoked as `node register-upload-retry.js`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reuploadUnuploaded } = require('../register-upload-retry');
const { markUploaded, loadUploadedIds } = require('../lib/upload-ledger');

test('reuploadUnuploaded uploads only results missing from the ledger and marks them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reupload-'));
  const resultsFile = path.join(dir, 'results.jsonl');
  const ledgerFile = path.join(dir, 'uploaded.jsonl');

  const r1 = { source: 'r1', username: 'u1', keys: [{ site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-1' }] };
  const r2 = { source: 'r2', username: 'u2', keys: [{ site: 'a6api', baseUrl: 'https://a6api.com', apiKey: 'sk-2' }] };
  fs.writeFileSync(resultsFile, [JSON.stringify(r1), JSON.stringify(r2)].join('\n'));
  markUploaded(r1, { ledgerFile }); // r1 already uploaded

  const uploaded = [];
  const res = await reuploadUnuploaded({
    resultsFile, ledgerFile, adminKey: 'admin-test', groupId: 1,
    buildAccountsFn: async (r) => ([{ name: 'n-' + r.source, platform: 'anthropic', type: 'apikey', credentials: { base_url: 'https://a6api.com', api_key: r.keys[0].apiKey, model_mapping: { x: 'x' } }, group_ids: [1] }]),
    uploadFn: async (accts) => { uploaded.push(accts[0].name); return { success: 1, failed: 0 }; },
  });

  assert.equal(res.attempted, 1);
  assert.equal(res.succeeded, 1);
  assert.deepEqual(uploaded, ['n-r2']);       // only r2 re-uploaded
  assert.ok(loadUploadedIds(ledgerFile).has('r2'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/register-upload-retry.test.js`
Expected: FAIL — module `register-upload-retry.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
// register-upload-retry.js
'use strict';
const path = require('path');
const { readAllResults, findUnuploaded, markUploaded } = require('./lib/upload-ledger');
const {
  buildAnthropicAccountsWithLiveModels,
  uploadAccounts,
  resolveDefaultGroupId,
  normalizeAdminKey,
  loadDotEnv,
} = require('./lib/api-nsnzd-uploader');

function applyDotEnv() {
  const env = loadDotEnv(path.join(__dirname, '.env'));
  for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
}

async function reuploadUnuploaded(opts = {}) {
  const resultsFile = opts.resultsFile || process.env.RESULT_LOCAL_FILE || path.join(__dirname, 'data', 'results.jsonl');
  const ledgerFile = opts.ledgerFile || process.env.UPLOAD_LEDGER_FILE || path.join(__dirname, 'data', 'uploaded.jsonl');
  const adminKey = opts.adminKey || normalizeAdminKey(process.env.API_NSNZD_COM_ADMIN_KEY || '');
  if (!adminKey) throw new Error('API_NSNZD_COM_ADMIN_KEY is required');
  const groupId = opts.groupId || await resolveDefaultGroupId({ adminKey });
  const buildAccounts = opts.buildAccountsFn || ((r, o) => buildAnthropicAccountsWithLiveModels(r, o));
  const doUpload = opts.uploadFn || ((a, o) => uploadAccounts(a, o));

  const results = readAllResults(resultsFile);
  const missing = findUnuploaded(results, ledgerFile);
  let succeeded = 0, failed = 0;
  for (const result of missing) {
    try {
      const accounts = await buildAccounts(result, { adminKey, groupIds: [groupId], groupName: 'default', concurrency: 1, priority: 1 });
      await doUpload(accounts, { adminKey });
      markUploaded(result, { ledgerFile });
      succeeded += 1;
      console.log(`[Reupload] ok: ${result.username || result.source}`);
    } catch (err) {
      failed += 1;
      console.log(`[Reupload] fail: ${result.username || result.source}: ${err.message}`);
    }
  }
  return { attempted: missing.length, succeeded, failed };
}

async function main() {
  applyDotEnv();
  const res = await reuploadUnuploaded({});
  console.log(`[Reupload] done: attempted=${res.attempted} succeeded=${res.succeeded} failed=${res.failed}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = { reuploadUnuploaded, main };
```

Add to `package.json` scripts: `"register:upload-retry": "node register-upload-retry.js"`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/register-upload-retry.test.js`
Expected: PASS (1 test).
Then `npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add register-upload-retry.js package.json test/register-upload-retry.test.js
git commit -m "feat(reupload): register:upload-retry re-uploads un-uploaded results from ledger"
```

---

### Task P2-7: Wire re-upload into the watcher startup + one-shot recovery run

**Files:**
- Modify: `pool-watcher.js` (entry — call `reuploadUnuploaded` once at startup before the loop)
- Test: none new (integration; covered by P2-6 unit test). Manual smoke below.

**Interfaces:**
- Consumes: `reuploadUnuploaded` from `./register-upload-retry`.

- [ ] **Step 1: Add startup recovery to the watcher entry**

In `pool-watcher.js` `main()`, after `applyDotEnv()` and before `runForever`, add:

```js
const { reuploadUnuploaded } = require('./register-upload-retry');
try {
  const rec = await reuploadUnuploaded({});
  console.log(`[pool] startup recovery: attempted=${rec.attempted} succeeded=${rec.succeeded} failed=${rec.failed}`);
} catch (err) {
  console.log(`[pool] startup recovery skipped: ${err.message}`);
}
```

(Place it inside the non-oneshot path, or run it in both — recovery is cheap and idempotent thanks to the ledger.)

- [ ] **Step 2: Manual smoke — recover the current backlog**

The repo currently has ~111 un-uploaded results in `data/results.jsonl` (pool dropped to 0). Run the recovery once directly:

```bash
cd /Users/haven/Documents/code/github-register
export API_NSNZD_COM_ADMIN_KEY='admin-238eda71c3f74210713fcc0d770f2c1f10af2a03e131819c6b637be5ff73ee8a'
export PROXY="socks5://jhw001-zone-custom:asdf1476@as.rrp.bestgo.work:10000"
node register-upload-retry.js
```

Expected: `[Reupload] done: attempted=<N> succeeded=<M> failed=<K>` — many of the historically-lost keys get uploaded (note: keys the upstream site has since revoked will fail, which is fine — they're logged and marked-attempted-but-not-marked-uploaded so a later run retries).

NOTE: this is a genuine bulk upload to api.nsnzd.com. Confirm with the user before running (it changes remote state). Do NOT run automatically as part of the plan.

- [ ] **Step 3: Commit**

```bash
git add pool-watcher.js
git commit -m "feat(pool-watcher): run un-uploaded recovery at startup"
```

---

## Self-Review

**Spec coverage:**
- Ledger of uploaded results (no pool-matching) → P2-1. ✓
- results.jsonl parsing → P2-2. ✓
- Proxy pool template (jhw001..jhw100, configurable) → P2-3. ✓
- `/v1/models` through proxy → P2-4. ✓
- Retry mint→build→upload + mark ledger → P2-5. ✓
- `register:upload-retry` recovery entry → P2-6. ✓
- Watcher startup recovery → P2-7. ✓

**Placeholder scan:** none. **Type consistency:** `resultId`/`markUploaded`/`findUnuploaded`/`readAllResults` names consistent P2-1,2,5,6. `generateProxyPool` shape used by later concurrency phase. `requestImpl` adapter shape (`{ok,status,text()}`) matches `parseApiResponse` in P2-4.

**Open risk flagged for reviewer:** P2-4 assumes `parseApiResponse(resp, {label})` reads only `.ok/.status/.text()`. The implementer must verify that signature before relying on the adapter; if `parseApiResponse` uses other response fields, widen the adapter.

## Execution Handoff

Continues the same SDD session on branch `feat/dynamic-pool-watcher`. Order: P2-1 → P2-7, then resume Phase 1 Tasks 8–12 (watcher loop + deploy). The concurrency scheduler is a separate Phase 3 plan (not yet written).
