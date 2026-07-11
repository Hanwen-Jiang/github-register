'use strict';

const fs = require('fs');
const path = require('path');

function listDataFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDataFiles(file, predicate));
    else if (predicate(file)) out.push(file);
  }
  return out;
}

function isJsonFile(file) {
  return /\.jsonl?$/i.test(file);
}

function discoverSessionFiles(rootDir = path.join(__dirname, '..')) {
  const dataDir = path.join(rootDir, 'data');
  const files = [];
  if (!fs.existsSync(dataDir)) return files;

  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const derived = /^sessions\.(?:merged|rescreened(?:\.|$))/i.test(entry.name);
    if ((!derived && /^sessions.*\.jsonl?$/i.test(entry.name)) || entry.name === 'github-cookies.json') {
      files.push(path.join(dataDir, entry.name));
    }
  }
  for (const subdir of ['remote-imports', 'backups', 'github-cookies']) {
    files.push(...listDataFiles(path.join(dataDir, subdir), isJsonFile));
  }
  return [...new Set(files)].sort();
}

function normalizeSessionRecord(value, sourceFile = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const storageState = value.storage_state || value.storageState || (
    Array.isArray(value.cookies) ? { cookies: value.cookies, origins: value.origins || [] } : null
  );
  const email = String(value.email || value.identity?.email || '').trim();
  const username = String(value.username || value.identity?.username || '').trim();
  if (!email && !username) return null;
  return {
    ...value,
    email,
    username,
    ...(storageState ? { storage_state: storageState } : {}),
    source_file: sourceFile,
  };
}

function valuesFromJson(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.sessions)) return value.sessions;
  return value && typeof value === 'object' ? [value] : [];
}

function readSessionArtifacts(files = []) {
  const records = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch (_) {
      continue;
    }
    if (!text) continue;
    const values = [];
    if (/\.jsonl$/i.test(file)) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { values.push(JSON.parse(line)); } catch (_) {}
      }
    } else {
      try { values.push(...valuesFromJson(JSON.parse(text))); } catch (_) {}
    }
    for (const value of values) {
      const record = normalizeSessionRecord(value, file);
      if (record) records.push(record);
    }
  }
  return records;
}

function recordTimestamp(record = {}) {
  for (const field of ['refreshed_at', 'last_used_at', 'updated_at', 'created_at']) {
    const time = Date.parse(record[field] || '');
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function mergeSessionRecords(records = []) {
  const byKey = new Map();
  for (const record of records) {
    const email = String(record.email || '').trim().toLowerCase();
    const username = String(record.username || '').trim().toLowerCase();
    const key = email ? `email:${email}` : (username ? `username:${username}` : '');
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, email, username, variants: [] });
    const identity = byKey.get(key);
    if (!identity.email && email) identity.email = email;
    if (!identity.username && username) identity.username = username;
    identity.variants.push(record);
  }
  for (const identity of byKey.values()) {
    identity.variants.sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
    const preferred = identity.variants[0] || {};
    identity.email = String(preferred.email || identity.email || '').trim().toLowerCase();
    identity.username = String(preferred.username || identity.username || '').trim().toLowerCase();
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function parseGithubUserSearch(json, username) {
  const expected = String(username || '').trim().toLowerCase();
  if (!expected) return false;
  const results = Array.isArray(json?.payload?.results) ? json.payload.results : [];
  return results.some(result => String(result?.login || '').trim().toLowerCase() === expected);
}

async function screenIdentity(identity, opts = {}) {
  if (typeof opts.searchUser !== 'function') throw new Error('searchUser is required');
  if (typeof opts.verifySession !== 'function') throw new Error('verifySession is required');
  const username = String(identity?.username || identity?.variants?.find(v => v.username)?.username || '').trim();
  if (!username) return { status: 'rejected', reason: 'missing_username', identity };

  let searchJson;
  try {
    searchJson = await opts.searchUser(username, identity);
  } catch (err) {
    throw new Error(`github search failed for ${username}: ${String(err.message || err)}`);
  }
  if (!parseGithubUserSearch(searchJson, username)) {
    return { status: 'rejected', reason: 'github_user_missing', identity };
  }

  let lastReason = 'session_expired';
  for (const session of identity.variants || []) {
    let verification;
    try {
      verification = await opts.verifySession(session, identity);
    } catch (err) {
      verification = { ok: false, reason: 'session_check_failed', error: String(err.message || err) };
    }
    if (verification?.ok) {
      return { status: 'usable', reason: 'session_live', identity, session, refreshed: false, verification };
    }
    lastReason = verification?.reason || lastReason;
    if (lastReason === 'github_suspended') {
      return { status: 'rejected', reason: lastReason, identity, session, refreshed: false, verification };
    }
  }

  const refreshBase = (identity.variants || []).find(session => session.email && session.password);
  if (!refreshBase || typeof opts.refreshSession !== 'function') {
    return { status: 'rejected', reason: lastReason, identity, refreshed: false };
  }

  let refreshed;
  try {
    const result = await opts.refreshSession(refreshBase, identity);
    refreshed = {
      ...refreshBase,
      status: 'active',
      version: 'refreshed',
      storage_state: result.storage_state || result.storageState || refreshBase.storage_state,
      proxy_url: result.proxyUrl ?? refreshBase.proxy_url ?? '',
      upstream_proxy_url: result.proxyUrl ?? refreshBase.upstream_proxy_url ?? refreshBase.proxy_url ?? '',
      browser_proxy_url: result.browserProxyUrl ?? refreshBase.browser_proxy_url ?? '',
      refreshed_at: result.refreshed_at || result.refreshedAt || new Date().toISOString(),
      last_error: null,
    };
  } catch (err) {
    return { status: 'rejected', reason: 'refresh_failed', error: String(err.message || err), identity, refreshed: false };
  }

  let verification;
  try {
    verification = await opts.verifySession(refreshed, identity);
  } catch (err) {
    verification = { ok: false, reason: 'session_check_failed', error: String(err.message || err) };
  }
  if (!verification?.ok) {
    return {
      status: 'rejected',
      reason: verification?.reason || 'refresh_verification_failed',
      identity,
      session: refreshed,
      refreshed: true,
      verification,
    };
  }
  return { status: 'usable', reason: 'session_refreshed', identity, session: refreshed, refreshed: true, verification };
}

function rejectedRecord(result) {
  const identity = result.identity || {};
  return {
    email: identity.email || '',
    username: identity.username || '',
    reason: result.reason || 'unknown',
    error: result.error || result.verification?.error || '',
    source_files: [...new Set((identity.variants || []).map(item => item.source_file).filter(Boolean))],
  };
}

async function rescreenSessions(opts = {}) {
  const identities = Array.isArray(opts.identities) ? opts.identities : [];
  const usable = [];
  const rejected = [];
  let refreshed = 0;
  const reasons = {};
  for (let index = 0; index < identities.length; index += 1) {
    const result = await screenIdentity(identities[index], opts);
    if (result.status === 'usable') {
      usable.push(result.session);
      if (result.refreshed) refreshed += 1;
    } else {
      const item = rejectedRecord(result);
      rejected.push(item);
      reasons[item.reason] = (reasons[item.reason] || 0) + 1;
    }
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({
        checked: index + 1,
        total: identities.length,
        usable: usable.length,
        rejected: rejected.length,
        refreshed,
      });
    }
  }
  return {
    mergedRecords: opts.mergedRecords || identities.flatMap(identity => identity.variants || []),
    usable,
    rejected,
    report: { total: identities.length, usable: usable.length, rejected: rejected.length, refreshed, reasons },
  };
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function jsonl(rows = []) {
  return rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
}

function writeRescreenOutputs(result, opts = {}) {
  const outputDir = opts.outputDir || path.join(__dirname, '..', 'data');
  const files = {
    mergedFile: opts.mergedFile || path.join(outputDir, 'sessions.merged.jsonl'),
    usableFile: opts.usableFile || path.join(outputDir, 'sessions.rescreened.usable.jsonl'),
    rejectedFile: opts.rejectedFile || path.join(outputDir, 'sessions.rescreened.rejected.jsonl'),
    reportFile: opts.reportFile || path.join(outputDir, 'sessions.rescreened.report.json'),
  };
  writeAtomic(files.mergedFile, jsonl(result.mergedRecords || []));
  writeAtomic(files.usableFile, jsonl(result.usable || []));
  writeAtomic(files.rejectedFile, jsonl(result.rejected || []));
  writeAtomic(files.reportFile, `${JSON.stringify(result.report || {}, null, 2)}\n`);
  return files;
}

module.exports = {
  discoverSessionFiles,
  normalizeSessionRecord,
  readSessionArtifacts,
  mergeSessionRecords,
  recordTimestamp,
  parseGithubUserSearch,
  screenIdentity,
  rescreenSessions,
  writeRescreenOutputs,
};
