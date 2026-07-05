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

test('resultId uses stable unique run identity instead of generic source labels', () => {
  assert.equal(resultId({ source: 'run-123' }), 'run-123');
  assert.equal(resultId({ source: 'fresh-registration', username: 'u1', uploaded_at: 't1' }), 'u1|t1|');
  assert.equal(resultId({ source: 'cookies', cookieFile: '/tmp/a.json', username: 'u2' }), '/tmp/a.json');
  assert.equal(resultId({ username: 'u1', uploaded_at: 't1' }), 'u1|t1|');
});

test('findUnuploaded does not collapse multiple fresh-registration rows', () => {
  const f = tmpLedger();
  const r1 = { source: 'fresh-registration', username: 'u1', uploaded_at: 't1' };
  const r2 = { source: 'fresh-registration', username: 'u2', uploaded_at: 't2' };
  markUploaded(r1, { ledgerFile: f });
  const missing = findUnuploaded([r1, r2], f);
  assert.deepEqual(missing.map(resultId), ['u2|t2|']);
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
