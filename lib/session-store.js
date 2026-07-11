// lib/session-store.js — playwright-free persistent store for GitHub sessions.
//
// Purpose: decouple "register a GitHub account" (Stage A) from "use a session to
// OAuth a guide-site" (Stage B). A persisted session is a reusable lead — the same
// GitHub account can later OAuth into any future guide-site.
//
// Storage: data/sessions.jsonl, one JSON object per line. APPEND-ONLY with
// last-wins reads (updateSession appends a merged line; readers keep the LAST
// record per email). This is concurrency-safe without locking: appendFileSync of a
// single line is atomic, and there is no read-modify-rewrite window to lose writes
// when the server's pool-watcher runs multiple Stage A/B jobs at once.
// compactSessions() collapses old lines when desired.
//
// Field names mirror the server-side Python session record
// (scripts/oauth_dynamic_registrar.py) so a future unified reader is trivial.
//
// Kept playwright-free so it is unit-testable locally (no node_modules).

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const SUSPENDED_STATUS = 'github_suspended';

function defaultFile(rootDir = process.cwd()) {
  return process.env.SESSIONS_FILE || path.join(rootDir, 'data', 'sessions.jsonl');
}

function defaultSuspendedFile(rootDir = process.cwd()) {
  return process.env.GITHUB_SUSPENDED_SESSIONS_FILE ||
    process.env.SUSPENDED_SESSIONS_FILE ||
    path.join(rootDir, 'data', 'sessions.suspended.jsonl');
}

function nowIso() {
  return new Date().toISOString();
}

function resolveFile(opts = {}) {
  return opts.file || defaultFile(opts.rootDir || process.cwd());
}

function inferRootDirFromSessionFile(file) {
  // Common layout: <root>/data/sessions.jsonl.
  const dir = path.dirname(file);
  return path.basename(dir) === 'data' ? path.dirname(dir) : dir;
}

function resolveSuspendedFile(opts = {}) {
  if (opts.suspendedFile) return opts.suspendedFile;
  const rootDir = opts.rootDir || inferRootDirFromSessionFile(resolveFile(opts));
  return defaultSuspendedFile(rootDir);
}

// Read all records in file order. Tolerates blank/corrupt lines (skips + warns).
// Returns raw records including historical duplicates (updates append new lines).
function listSessionsRaw(opts = {}) {
  const file = resolveFile(opts);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (_) {
      if (!opts.quiet) console.warn(`[session-store] skipping corrupt line in ${file}`);
    }
  }
  return out;
}

// Collapse to the latest record per email (last-wins), preserving first-seen order.
function listSessions(opts = {}) {
  const rawList = listSessionsRaw(opts);
  const byEmail = new Map();
  const order = [];
  for (const rec of rawList) {
    const key = String(rec.email || '').toLowerCase();
    if (!key) continue;
    if (!byEmail.has(key)) order.push(key);
    byEmail.set(key, rec); // last-wins
  }
  return order.map(k => byEmail.get(k));
}

// Latest record for one email (last-wins), or null.
function findSession(email, opts = {}) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  let found = null;
  for (const rec of listSessionsRaw(opts)) {
    if (String(rec.email || '').toLowerCase() === key) found = rec;
  }
  return found;
}

// Append one line atomically (O_APPEND single write). Fills required timestamps
// and schema version. Returns the normalized record.
function appendSession(record, opts = {}) {
  if (!record || !record.email) throw new Error('appendSession: record.email is required');
  const file = resolveFile(opts);
  const normalized = {
    schema_version: SCHEMA_VERSION,
    created_at: record.created_at || nowIso(),
    last_used_at: record.last_used_at || nowIso(),
    sites_registered: record.sites_registered || {},
    status: record.status || 'active',
    last_result_keys: record.last_result_keys ?? 0,
    empty_keys: record.empty_keys ?? true,
    last_error: record.last_error ?? null,
    ...record,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`);
  return normalized;
}

function appendSuspendedSession(record, opts = {}) {
  if (!record || !record.email) throw new Error('appendSuspendedSession: record.email is required');
  const file = resolveSuspendedFile(opts);
  const normalized = {
    schema_version: SCHEMA_VERSION,
    created_at: record.created_at || nowIso(),
    last_used_at: record.last_used_at || nowIso(),
    sites_registered: record.sites_registered || {},
    status: SUSPENDED_STATUS,
    last_result_keys: record.last_result_keys ?? 0,
    empty_keys: record.empty_keys ?? true,
    last_error: record.last_error ?? null,
    suspended_at: record.suspended_at || nowIso(),
    ...record,
    status: SUSPENDED_STATUS,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`);
  return normalized;
}

function listSuspendedSessions(opts = {}) {
  return listSessionsRaw({ ...opts, file: resolveSuspendedFile(opts) });
}

// Merge patch into the latest record for `email` and append the merged result as a
// new line (append-only). sites_registered is DEEP-merged by site key; other keys
// are shallow-overwritten. Refreshes last_used_at. Throws if not found unless
// opts.upsert is set (then patch must carry enough to be a valid new record).
function updateSession(email, patch = {}, opts = {}) {
  const current = findSession(email, opts);
  if (!current) {
    if (opts.upsert) return appendSession({ email, ...patch }, opts);
    throw new Error(`updateSession: no session for ${email}`);
  }
  const merged = { ...current, ...patch };
  if (patch.sites_registered) {
    merged.sites_registered = { ...(current.sites_registered || {}), ...patch.sites_registered };
  }
  merged.email = current.email; // never let a patch rewrite the key
  merged.created_at = current.created_at || merged.created_at;
  merged.last_used_at = patch.last_used_at || nowIso();
  return appendSession(merged, opts);
}

function quarantineSuspendedSession(email, patch = {}, opts = {}) {
  const suspendedAt = patch.suspended_at || nowIso();
  const updated = updateSession(email, {
    ...patch,
    status: SUSPENDED_STATUS,
    suspended_at: suspendedAt,
  }, opts);
  appendSuspendedSession(updated, opts);
  return updated;
}

// Convenience: record that `email` OAuth-registered at `siteName`, recomputing
// last_result_keys / empty_keys across all registered sites.
function markSiteRegistered(email, siteName, info = {}, opts = {}) {
  const current = findSession(email, opts);
  if (!current) throw new Error(`markSiteRegistered: no session for ${email}`);
  const sites = { ...(current.sites_registered || {}) };
  sites[siteName] = {
    user_id: info.userId ?? sites[siteName]?.user_id ?? null,
    keys: info.keys ?? sites[siteName]?.keys ?? [],
    account_id: info.accountId ?? sites[siteName]?.account_id ?? null,
    registered_at: nowIso(),
  };
  const totalKeys = Object.values(sites).reduce((n, s) => n + ((s && s.keys ? s.keys.length : 0)), 0);
  return updateSession(email, {
    sites_registered: sites,
    last_result_keys: totalKeys,
    empty_keys: totalKeys === 0,
  }, opts);
}

// Find a session reusable for OAuth into `targetSite`. Mirrors the server-side
// find_reusable_session (scripts/oauth_dynamic_registrar.py:296):
//   status==='active', not empty_keys, last_result_keys!==0, target site NOT already
//   registered, proxy in allowlist (when opts.allowedProxies given), and — when
//   opts.requireAccountId — at least one registered site carries an account_id.
// Picks the OLDEST by last_used_at||created_at so saved profiles drain gradually.
function findReusableSession(targetSite, opts = {}) {
  const allowed = opts.allowedProxies; // array or undefined (undefined = no proxy filter)
  const requireAccountId = !!opts.requireAccountId;
  const candidates = listSessions(opts).filter(sess => {
    if (sess.status !== 'active') return false;
    if (sess.empty_keys) return false;
    if (sess.last_result_keys === 0) return false;
    if (allowed && !(sess.proxy_url && allowed.includes(sess.proxy_url))) return false;
    const registered = sess.sites_registered || {};
    if (targetSite in registered) return false;
    if (requireAccountId && !Object.values(registered).some(v => v && v.account_id)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    String(a.last_used_at || a.created_at || '').localeCompare(String(b.last_used_at || b.created_at || '')));
  return candidates[0];
}

function hasGithubCookies(sess) {
  const cookies = sess?.storage_state?.cookies || [];
  return cookies.some(c => {
    const domain = String(c.domain || '').toLowerCase();
    return domain === 'github.com' || domain.endsWith('.github.com');
  });
}

// Pick any active GitHub session that can OAuth into targetSite.
// Preference order:
//   1. A lead session that already produced keys elsewhere (findReusableSession)
//   2. A fresh GitHub-only session with valid GitHub cookies
function findAvailableSession(targetSite, opts = {}) {
  const reusable = findReusableSession(targetSite, opts);
  if (reusable) return reusable;

  const allowed = opts.allowedProxies;
  const candidates = listSessions(opts).filter(sess => {
    if (sess.status !== 'active') return false;
    if (allowed && !(sess.proxy_url && allowed.includes(sess.proxy_url))) return false;
    if ((sess.sites_registered || {})[targetSite]) return false;
    if (!hasGithubCookies(sess)) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    String(a.last_used_at || a.created_at || '').localeCompare(String(b.last_used_at || b.created_at || '')));
  return candidates[0];
}

// The Playwright-cookie array that runSitesOAuthHttp (lib/hybrid-oauth.js) expects.
function getSessionCookies(record) {
  return (record && record.storage_state && record.storage_state.cookies) || [];
}

// Full storageState for browser re-import (newContext({ storageState })).
function toStorageState(record) {
  return (record && record.storage_state) || { cookies: [], origins: [] };
}

// Rewrite the file keeping only the latest record per email (drops superseded
// append-only lines). Uses temp+rename; run only when no concurrent writers.
function compactSessions(opts = {}) {
  const file = resolveFile(opts);
  const latest = listSessions(opts);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, latest.map(r => JSON.stringify(r)).join('\n') + (latest.length ? '\n' : ''));
  fs.renameSync(tmp, file);
  return latest.length;
}

module.exports = {
  SCHEMA_VERSION, SUSPENDED_STATUS, defaultFile, defaultSuspendedFile,
  listSessionsRaw, listSessions, findSession,
  appendSession, updateSession, markSiteRegistered,
  appendSuspendedSession, listSuspendedSessions, quarantineSuspendedSession,
  findReusableSession, findAvailableSession, getSessionCookies, toStorageState, compactSessions,
};
