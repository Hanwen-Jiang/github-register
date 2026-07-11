#!/usr/bin/env node
'use strict';

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
  const out = { refreshExpired: true, outputDir: '', limit: Infinity, searchDelayMs: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-refresh') out.refreshExpired = false;
    else if (argv[i] === '--output-dir') out.outputDir = argv[++i] || '';
    else if (argv[i] === '--limit') out.limit = parsePositive(argv[++i], Infinity) || Infinity;
    else if (argv[i] === '--search-delay-ms') out.searchDelayMs = parsePositive(argv[++i], 100);
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

async function requestGithubUserSearch(client, username) {
  const url = `https://github.com/search?q=${encodeURIComponent(username)}&type=users`;
  const response = await client.get(url, {
    accept: 'application/json',
    'accept-language': 'en,zh-CN;q=0.9,zh;q=0.8',
    referer: url,
    'x-github-app-type': 'navigator',
    'x-github-target': 'dotcom',
    'x-react-router': 'json',
    'x-requested-with': 'XMLHttpRequest',
  });
  const json = response.json();
  if (response.status !== 200 || !Array.isArray(json?.payload?.results)) {
    throw new Error(`github search unavailable status=${response.status}`);
  }
  return json;
}

async function findSearchClient(records, opts = {}) {
  const probeUsername = opts.probeUsername || process.env.GITHUB_SEARCH_PROBE_USERNAME || 'nsnzd-laylazhao674305';
  for (const session of records) {
    if (!store.getSessionCookies(session).length) continue;
    try {
      const client = new HttpClient({ proxyUrl: resolveSessionProxyUrl(session) });
      client.importPlaywrightCookies(store.getSessionCookies(session));
      const json = await requestGithubUserSearch(client, probeUsername);
      if (parseGithubUserSearch(json, probeUsername)) return client;
    } catch (_) {}
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
  console.log(`[session-rescreen] files=${files.length} rows=${records.length} identities=${identities.length}`);

  const searchClient = opts.searchClient || await findSearchClient(records, opts);
  let lastSearchAt = 0;
  const searchUser = opts.searchUser || (async username => {
    const wait = Math.max(0, args.searchDelayMs - (Date.now() - lastSearchAt));
    if (wait) await sleep(wait);
    const json = await requestGithubUserSearch(searchClient, username);
    lastSearchAt = Date.now();
    return json;
  });
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
  const outputDir = args.outputDir ? path.resolve(args.outputDir) : path.join(rootDir, 'data');
  const outputFiles = writeRescreenOutputs(result, { outputDir });
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
  findSearchClient,
  verifyGithubSession,
  main,
};
