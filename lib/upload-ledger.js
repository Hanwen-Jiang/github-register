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
