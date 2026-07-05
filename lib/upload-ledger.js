// lib/upload-ledger.js
'use strict';
const fs = require('fs');
const path = require('path');

function resultId(result) {
  if (!result) return '|';
  const source = String(result.source || '');
  if (source && !['fresh-registration', 'cookies'].includes(source)) return source;
  if (source === 'cookies' && result.cookieFile) return String(result.cookieFile);
  const keyFingerprint = Array.isArray(result.keys)
    ? result.keys.map(k => `${k.site || ''}:${k.userId || ''}:${k.profile || ''}:${String(k.apiKey || '').slice(-10)}`).join(',')
    : '';
  return `${result.username || ''}|${result.uploaded_at || ''}|${keyFingerprint}`;
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

module.exports = { resultId, markUploaded, loadUploadedIds, findUnuploaded, readAllResults };
