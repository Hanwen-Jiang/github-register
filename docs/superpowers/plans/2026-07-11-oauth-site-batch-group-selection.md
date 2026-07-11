# OAuth Site Batch Group Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible GitHub session pool and make `oauth:site:batch` discover, multi-select, persist, reuse, and correctly apply per-site token groups.

**Architecture:** A focused session-rescreener module produces a derived usable JSONL pool. A site-group module owns live response normalization, a6api-only fallback, prompt parsing, and atomic config persistence. Hybrid OAuth exposes authenticated group discovery and consumes explicit per-site selections, while the batch CLI orchestrates preflight and reuse.

**Tech Stack:** Node.js 20 CommonJS, built-in `node:test`, existing `HttpClient`, Playwright refresh flow, JSON/JSONL files.

---

### Task 1: Session Artifact Discovery And Merge

**Files:**
- Create: `lib/github-session-rescreener.js`
- Create: `test/github-session-rescreener.test.js`

- [ ] **Step 1: Write failing discovery and merge tests**

Test that `discoverSessionFiles(rootDir)` includes session JSONL, imports, backups, and cookie archives but excludes reports, and that `mergeSessionRecords(records)` groups duplicate email variants without dropping storage states.

- [ ] **Step 2: Verify RED**

Run `node --test test/github-session-rescreener.test.js`; expect module-not-found or missing export failures.

- [ ] **Step 3: Implement normalization and grouping**

Export:

```js
discoverSessionFiles(rootDir)
readSessionArtifacts(files)
normalizeSessionRecord(value, sourceFile)
mergeSessionRecords(records)
```

Support JSONL arrays, `{sessions: []}`, single session objects, and cookie archive objects. Sort variants newest-first by `refreshed_at`, `last_used_at`, `updated_at`, then `created_at`.

- [ ] **Step 4: Verify GREEN**

Run the focused test and expect all cases to pass.

### Task 2: GitHub Account And Cookie Screening

**Files:**
- Modify: `lib/github-session-rescreener.js`
- Modify: `test/github-session-rescreener.test.js`

- [ ] **Step 1: Write failing screening tests**

Cover exact `payload.results[].login` matching, empty-result rejection, retryable search errors, selecting a later live cookie variant, and invoking refresh only when every stored variant is expired.

- [ ] **Step 2: Verify RED**

Run the focused test; expect missing `parseGithubUserSearch`, `screenIdentity`, and `rescreenSessions` failures.

- [ ] **Step 3: Implement dependency-injected screening**

Export:

```js
parseGithubUserSearch(json, username)
verifyGithubSession(session, opts)
screenIdentity(identity, opts)
rescreenSessions(opts)
writeRescreenOutputs(result, opts)
```

Search through an injected `searchUser`, verify through injected `verifySession`, refresh through optional `refreshSession`, and return explicit reasons such as `github_user_missing`, `session_expired`, `refresh_failed`, and `github_suspended`.

- [ ] **Step 4: Verify GREEN**

Run the focused test and expect all screening cases to pass.

### Task 3: Session Rescreen CLI

**Files:**
- Create: `rescreen-github-sessions.js`
- Modify: `package.json`
- Modify: `test/github-session-rescreener.test.js`

- [ ] **Step 1: Write failing CLI/config tests**

Verify defaults, `--no-refresh`, output path overrides, and `SESSION_STORE_FILE` selection.

- [ ] **Step 2: Verify RED**

Run the focused test; expect missing CLI parser failures.

- [ ] **Step 3: Implement CLI**

Add `npm run sessions:rescreen`. Use a search-capable session for navigator JSON requests, existing `refreshOneWithBrowser` for refresh, atomic output writes, bounded delay, progress counts, and redacted logs.

- [ ] **Step 4: Verify GREEN**

Run focused tests, then a small injected dry run.

### Task 4: Site Group Options And Persistence

**Files:**
- Create: `lib/site-groups.js`
- Create: `test/site-groups.test.js`

- [ ] **Step 1: Write failing group tests**

Cover object-map/array live responses, a6api-only routing fallback, single default fallback for other sites, comma/value/`all` multi-selection, version validation, missing target sites, and atomic round-trip persistence.

- [ ] **Step 2: Verify RED**

Run `node --test test/site-groups.test.js`; expect module-not-found or missing exports.

- [ ] **Step 3: Implement group helpers**

Export:

```js
normalizeLiveGroupOptions(data)
fallbackGroupOptions(site, routingProfiles)
parseGroupMultiSelection(answer, options)
promptSiteGroupSelection(site, options, opts)
readGroupConfig(file, targetSites)
writeGroupConfig(file, config)
```

Ensure only a6api receives routing payload fields.

- [ ] **Step 4: Verify GREEN**

Run the focused group test and expect all cases to pass.

### Task 5: Split OAuth Authentication, Discovery, And Minting

**Files:**
- Modify: `lib/hybrid-oauth.js`
- Modify: `test/hybrid-oauth.test.js`
- Modify: `test/routing-profiles.test.js`

- [ ] **Step 1: Write failing behavior tests**

Assert that authenticated discovery calls `/api/user/self/groups`, two live selections produce exactly two token POSTs with their group values, a6api fallback selections retain routing fields, and cun.ai/xyc.ai never receive routing fields without explicit selections.

- [ ] **Step 2: Verify RED**

Run the two focused test files; expect wrong POST counts and global profile pollution failures.

- [ ] **Step 3: Refactor minimally**

Export:

```js
authenticateSiteOAuthHttp(site, githubCookies, opts)
fetchSiteGroupOptionsHttp(auth, opts)
mintSiteKeysHttp(auth, selections, opts)
probeSiteGroupsHttp(site, githubCookies, opts)
```

Make `runSiteOAuthHttp` compose these helpers and default to one legacy selection when none is provided.

- [ ] **Step 4: Verify GREEN**

Run focused OAuth tests and expect exact group payloads and key counts.

### Task 6: Configurable Session Store File

**Files:**
- Modify: `lib/session-store.js`
- Modify: `test/session-store.test.js`

- [ ] **Step 1: Write failing file-selection tests**

Verify `SESSION_STORE_FILE` and `{sessionFile}` redirect reads/appends without changing default paths.

- [ ] **Step 2: Verify RED**

Run `node --test test/session-store.test.js`; expect the custom file to be ignored.

- [ ] **Step 3: Implement centralized path resolution**

Route every list/find/update/append helper through one `sessionsPath(rootDir, opts)` resolution function while preserving existing APIs.

- [ ] **Step 4: Verify GREEN**

Run session store tests and expect both default and custom paths to pass.

### Task 7: Batch Preflight, Prompting, And Reuse

**Files:**
- Modify: `oauth-site-batch.js`
- Modify: `oauth-site.js`
- Modify: `test/oauth-site-batch.test.js`
- Modify: `test/oauth-site.test.js`

- [ ] **Step 1: Write failing batch tests**

Cover `--group-config`, `--reuse-group-config`, upload-group-first ordering, one preflight account per target site, live/fallback prompts, atomic save before `runBatch`, reuse skipping resolvers/prompts, and forwarding selections into OAuth.

- [ ] **Step 2: Verify RED**

Run both focused tests; expect missing argument/config/preflight behavior.

- [ ] **Step 3: Implement orchestration**

Add:

```js
parseBatchArgs(argv)
prepareBatchGroupConfig(env, args, opts)
applyBatchGroupConfigEnv(env, config, file)
```

Use `OAUTH_SITE_GROUP_CONFIG_FILE` for child/direct calls. Remove global `routingProfiles` from `oauth-site.js`; resolve selections per site from the persisted config.

- [ ] **Step 4: Verify GREEN**

Run focused batch and OAuth-site tests and expect prompt/reuse ordering plus unchanged upload settings.

### Task 8: Documentation, Full Verification, And Runtime Evidence

**Files:**
- Modify: `.env.example`
- Modify: `RUNBOOK.md`

- [ ] **Step 1: Document commands**

Document `npm run sessions:rescreen`, default output files, normal interactive batch execution, `npm run oauth:site:batch -- --reuse-group-config`, and `--group-config <path>`.

- [ ] **Step 2: Run full automated verification**

Run `npm test`; expect zero failures.

- [ ] **Step 3: Run session rescreen and live group probe**

Run the rescreener with progress/report output, verify at least one usable session, then perform a no-key a6api group probe and expect HTTP 200 with normalized options.

- [ ] **Step 4: Audit the objective**

Confirm upload group selection remains unchanged, every site has choices, multi-select maps one-to-one to keys, config is persisted, reuse skips prompts, routing profiles are a6api-only fallback, and upload concurrency/priority code is unchanged.
