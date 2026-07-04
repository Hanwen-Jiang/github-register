const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendLocalResult, normalizeResult } = require('../lib/result-uploader');

test('normalizeResult adds upload timestamp and metadata', () => {
  const result = normalizeResult({ success: true, keys: [] }, { source: 'test' });
  assert.equal(result.success, true);
  assert.equal(result.meta.source, 'test');
  assert.match(result.uploaded_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('appendLocalResult writes JSONL archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'result-uploader-'));
  const file = path.join(root, 'results.jsonl');
  appendLocalResult({ success: true, keys: [{ site: 'cun.ai' }] }, { file });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).keys[0].site, 'cun.ai');
});
