#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  discoverSessionFiles,
  readSessionArtifacts,
  mergeSessionRecords,
  parseGithubUserSearch,
  rescreenSessions,
  writeRescreenOutputs,
} = require('./lib/github-session-rescreener');
const store = require('./lib/session-store');
const { HttpClient } = require('./lib/http-client');
const { resolveSessionProxyUrl, isGithubSuspendedError } = require('./oauth-site');

function parsePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  // 2026-07-11 runtime checks matched individual searches through 6 names;
  // batches of 7 or more returned false-empty results.
  const out = { refreshExpired: true, outputDir: '', limit: Infinity, searchDelayMs: 100, searchBatchSize: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-refresh') out.refreshExpired = false;
    else if (argv[i] === '--output-dir') out.outputDir = argv[++i] || '';
    else if (argv[i] === '--limit') out.limit = parsePositive(argv[++i], Infinity) || Infinity;
    else if (argv[i] === '--search-delay-ms') out.searchDelayMs = parsePositive(argv[++i], 100);
    else if (argv[i] === '--search-batch-size') out.searchBatchSize = parsePositive(argv[++i], 6) || 6;
  }
  return out;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestGithubUserSearch(client, username, opts = {}) {
  const url = `https://github.com/search?q=${encodeURIComponent(username)}&type=users`;
  const retries = opts.retries ?? 6;
  const doSleep = opts.sleep || sleep;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await client.get(url, {
        accept: 'application/json',
        'accept-language': 'en,zh-CN;q=0.9,zh;q=0.8',
        referer: url,
        'x-github-app-type': 'navigator',
        'x-github-target': 'dotcom',
        'x-react-router': 'json',
        'x-requested-with': 'XMLHttpRequest',
      });
    } catch (err) {
      const transient = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err?.code);
      if (!transient || attempt >= retries) throw err;
      const waitMs = Math.min(60000, 5000 * (2 ** attempt));
      if (typeof opts.onRetry === 'function') {
        opts.onRetry({ username, attempt: attempt + 1, waitMs, status: err.code });
      }
      await doSleep(waitMs);
      continue;
    }
    const json = response.json();
    if (response.status === 200 && Array.isArray(json?.payload?.results)) return json;
    if (response.status !== 429 || attempt >= retries) {
      throw new Error(`github search unavailable status=${response.status}`);
    }
    const retryAfter = Number(headerValue(response.headers, 'retry-after'));
    const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(120000, 15000 * (2 ** attempt));
    if (typeof opts.onRetry === 'function') {
      opts.onRetry({ username, attempt: attempt + 1, waitMs: backoffMs, status: response.status });
    }
    await doSleep(backoffMs);
  }
  throw new Error('github search retry loop exhausted');
}

async function searchGithubUsersInBatches(usernames, opts = {}) {
  if (typeof opts.requestSearch !== 'function') throw new Error('requestSearch is required');
  const batchSize = Math.max(1, Number(opts.batchSize || 10));
  const delayMs = Math.max(0, Number(opts.delayMs || 0));
  const doSleep = opts.sleep || sleep;
  const unique = [...new Set((usernames || []).map(name => String(name || '').trim().toLowerCase()).filter(Boolean))];
  const knownResults = opts.knownResults instanceof Map ? new Map(opts.knownResults) : new Map();
  const alive = new Set([...knownResults].filter(([, exists]) => exists).map(([name]) => name));
  const pending = unique.filter(name => !knownResults.has(name));
  const totalBatches = Math.ceil(pending.length / batchSize);
  for (let offset = 0, batch = 0; offset < pending.length; offset += batchSize, batch += 1) {
    if (batch > 0 && delayMs > 0) await doSleep(delayMs);
    const names = pending.slice(offset, offset + batchSize);
    const json = await opts.requestSearch(names.join(' OR '), names);
    const expected = new Set(names.map(name => name.toLowerCase()));
    for (const name of names) knownResults.set(name, false);
    for (const result of json?.payload?.results || []) {
      const login = String(result?.login || '').trim();
      if (expected.has(login.toLowerCase())) {
        alive.add(login.toLowerCase());
        knownResults.set(login.toLowerCase(), true);
      }
    }
    if (typeof opts.onBatchResult === 'function') opts.onBatchResult(new Map(knownResults));
    if (typeof opts.onBatch === 'function') {
      opts.onBatch({
        batch: batch + 1,
        totalBatches,
        checked: unique.length - pending.length + Math.min(offset + names.length, pending.length),
        total: unique.length,
      });
    }
  }
  return alive;
}

function searchFingerprint(usernames) {
  return crypto.createHash('sha256')
    .update([...new Set(usernames.map(name => String(name).toLowerCase()))].sort().join('\n'))
    .digest('hex');
}

function readSearchProgress(file, fingerprint, usernames = []) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || !value.results || typeof value.results !== 'object') return new Map();
    const currentNames = new Set(usernames.map(name => String(name || '').trim().toLowerCase()).filter(Boolean));
    if (value.fingerprint !== fingerprint && currentNames.size === 0) return new Map();
    return new Map(Object.entries(value.results)
      .map(([name, exists]) => [name.toLowerCase(), Boolean(exists)])
      .filter(([name]) => currentNames.size === 0 || currentNames.has(name)));
  } catch (_) {
    return new Map();
  }
}

function writeSearchProgress(file, fingerprint, results) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify({
    version: 1,
    fingerprint,
    updatedAt: new Date().toISOString(),
    results: Object.fromEntries(results),
  }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

async function findSearchClient(records, opts = {}) {
  const probeUsername = opts.probeUsername || process.env.GITHUB_SEARCH_PROBE_USERNAME || 'nsnzd-laylazhao674305';
  const priority = session => {
    const source = String(session.source_file || '');
    if (/sessions\.rescreened\.usable\.jsonl$/i.test(source)) return 0;
    if (/sessions\.win_gw_lou\.usable\.jsonl$/i.test(source)) return 1;
    if (/[/\\]sessions\.jsonl$/i.test(source)) return 2;
    return 3;
  };
  const candidates = records.slice().sort((a, b) => priority(a) - priority(b));
  const createClient = opts.clientFactory || (session => {
    const client = new HttpClient({ proxyUrl: resolveSessionProxyUrl(session) });
    client.importPlaywrightCookies(store.getSessionCookies(session));
    return client;
  });
  const requestSearch = opts.requestSearch || (client => requestGithubUserSearch(client, probeUsername, { retries: 0 }));
  for (let index = 0; index < candidates.length; index += 1) {
    const session = candidates[index];
    if (!store.getSessionCookies(session).length) continue;
    try {
      const client = createClient(session);
      const json = await requestSearch(client, probeUsername, session);
      if (parseGithubUserSearch(json, probeUsername)) return client;
    } catch (err) {
      if (/status=429\b/.test(String(err.message || err))) throw err;
    }
    if (typeof opts.onCandidate === 'function') opts.onCandidate({ checked: index + 1, total: candidates.length });
  }
  throw new Error('no search-capable GitHub session found');
}

async function verifyGithubSession(session) {
  const client = new HttpClient({ proxyUrl: resolveSessionProxyUrl(session) });
  client.importPlaywrightCookies(store.getSessionCookies(session));
  const response = await client.get('https://github.com/settings/profile', { accept: 'text/html,application/xhtml+xml' });
  const location = headerValue(response.headers, 'location');
  const body = response.text();
  if (isGithubSuspendedError(body) || /\/suspended\b/i.test(location)) return { ok: false, reason: 'github_suspended' };
  const ok = response.status === 200 && /Public profile|Your profile|Profile settings/i.test(body) && !/Sign in to GitHub/i.test(body);
  return ok ? { ok: true } : { ok: false, reason: 'session_expired', status: response.status };
}

async function main(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const args = opts.args || parseArgs();
  const files = discoverSessionFiles(rootDir);
  const records = readSessionArtifacts(files);
  const identities = mergeSessionRecords(records).slice(0, args.limit);
  const outputDir = args.outputDir ? path.resolve(args.outputDir) : path.join(rootDir, 'data');
  const searchProgressFile = path.join(outputDir, 'sessions.rescreened.search-progress.json');
  const usernames = identities.map(identity => identity.username);
  const fingerprint = searchFingerprint(usernames);
  const knownSearchResults = readSearchProgress(searchProgressFile, fingerprint, usernames);
  console.log(`[session-rescreen] files=${files.length} rows=${records.length} identities=${identities.length}`);
  if (knownSearchResults.size) console.log(`[session-rescreen] resume account search results=${knownSearchResults.size}/${identities.length}`);

  const searchClient = opts.searchClient || await findSearchClient(records, opts);
  console.log('[session-rescreen] GitHub search session ready');
  let searchUser = opts.searchUser;
  if (!searchUser) {
    const alive = await searchGithubUsersInBatches(usernames, {
      batchSize: opts.searchBatchSize || args.searchBatchSize,
      delayMs: args.searchDelayMs,
      knownResults: knownSearchResults,
      requestSearch: query => requestGithubUserSearch(searchClient, query, {
        onRetry: ({ attempt, waitMs }) => {
          console.log(`[session-rescreen] GitHub search rate limited; retry=${attempt} wait=${Math.ceil(waitMs / 1000)}s`);
        },
      }),
      onBatchResult: results => writeSearchProgress(searchProgressFile, fingerprint, results),
      onBatch: progress => {
        if (progress.batch === progress.totalBatches || progress.batch % 10 === 0) {
          console.log(`[session-rescreen] account search batches=${progress.batch}/${progress.totalBatches} usernames=${progress.checked}/${progress.total}`);
        }
      },
    });
    searchUser = async username => ({
      payload: { results: alive.has(String(username).toLowerCase()) ? [{ login: username }] : [] },
    });
  }
  const refreshSession = args.refreshExpired
    ? (opts.refreshSession || (async session => {
        const refresh = require('./refresh-github-sessions');
        refresh.loadEnv();
        return refresh.refreshOneWithBrowser(session, { rootDir, headless: true });
      }))
    : undefined;

  const result = await rescreenSessions({
    identities,
    mergedRecords: records,
    searchUser,
    verifySession: opts.verifySession || verifyGithubSession,
    refreshSession,
    onProgress: opts.onProgress || (progress => {
      if (progress.checked === progress.total || progress.checked % 25 === 0) {
        console.log(`[session-rescreen] checked=${progress.checked}/${progress.total} usable=${progress.usable} rejected=${progress.rejected} refreshed=${progress.refreshed}`);
      }
    }),
  });
  const outputFiles = writeRescreenOutputs(result, { outputDir });
  fs.rmSync(searchProgressFile, { force: true });
  console.log(`[session-rescreen] done usable=${result.report.usable} rejected=${result.report.rejected} refreshed=${result.report.refreshed}`);
  console.log(`[session-rescreen] usable_file=${outputFiles.usableFile}`);
  return { ...result, files: outputFiles };
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  requestGithubUserSearch,
  searchGithubUsersInBatches,
  findSearchClient,
  searchFingerprint,
  readSearchProgress,
  writeSearchProgress,
  verifyGithubSession,
  main,
};
