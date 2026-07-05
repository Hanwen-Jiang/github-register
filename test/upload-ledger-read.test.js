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
