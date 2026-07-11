const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const id = require('../lib/identity');

function tmpFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idtest-'));
  const file = path.join(dir, 'records.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

test('generateLocalPart produces varied shapes (separators + optional digits)', () => {
  const seen = new Set();
  let withDigits = 0;
  for (let i = 0; i < 400; i++) {
    const lp = id.generateLocalPart();
    assert.match(lp, /^[a-z][a-z._0-9]*$/, `bad local part: ${lp}`);
    if (/[0-9]/.test(lp)) withDigits++;
    seen.add(lp);
  }
  // High variety: 400 draws should yield many distinct locals.
  assert.ok(seen.size > 300, `expected >300 unique, got ${seen.size}`);
  // Some (but not all) carry digits.
  assert.ok(withDigits > 50 && withDigits < 350, `digit ratio off: ${withDigits}/400`);
});

test('cleanName strips disambiguation digits and non-letters', () => {
  assert.equal(id.cleanName('wang2'), 'wang');
  assert.equal(id.cleanName('Xu.'), 'xu');
  assert.equal(id.cleanName('OLIVIA'), 'olivia');
});

test('harvestFromJsonl collects emails and usernames, tolerating junk', () => {
  const file = tmpFile([
    JSON.stringify({ email: 'A.B@nsnzd.com', username: 'nsnzd-abc123' }),
    'not json at all',
    '',
    JSON.stringify({ email: 'c.d@nsnzd.com' }),
  ]);
  const sink = { emails: new Set(), usernames: new Set() };
  id.harvestFromJsonl(file, sink);
  assert.ok(sink.emails.has('a.b@nsnzd.com')); // lowercased
  assert.ok(sink.emails.has('c.d@nsnzd.com'));
  assert.ok(sink.usernames.has('nsnzd-abc123'));
  assert.equal(sink.emails.size, 2);
});

test('harvestFromJsonl on a missing file does not throw', () => {
  const sink = { emails: new Set(), usernames: new Set() };
  assert.doesNotThrow(() => id.harvestFromJsonl('/no/such/file.jsonl', sink));
  assert.equal(sink.emails.size, 0);
});

test('generateUniqueEmail avoids used addresses', () => {
  // Pre-seed a used set with everything the generator could plausibly emit for
  // one name pair, then assert the returned email is never in the used set.
  const used = { emails: new Set(['taken@nsnzd.com']), usernames: new Set() };
  for (let i = 0; i < 200; i++) {
    const email = id.generateUniqueEmail(used, { domain: 'nsnzd.com' });
    assert.ok(email.endsWith('@nsnzd.com'));
    assert.ok(!used.emails.has(email.toLowerCase()));
    used.emails.add(email.toLowerCase()); // accumulate; still must never collide
  }
});

test('generateUniqueUsername avoids used names, stays safe, and never uses nsnzd prefix', () => {
  const used = { emails: new Set(), usernames: new Set() };
  for (let i = 0; i < 200; i++) {
    const name = id.generateUniqueUsername(used);
    assert.match(name, /^[a-z][a-z0-9-]{2,38}$/, `unsafe: ${name}`);
    assert.ok(!name.toLowerCase().startsWith('nsnzd-'), `forbidden nsnzd prefix: ${name}`);
    assert.ok(name.length <= 39);
    assert.ok(!used.usernames.has(name.toLowerCase()));
    used.usernames.add(name.toLowerCase());
  }
});

test('loadUsed merges multiple files via explicit files opt', () => {
  const f1 = tmpFile([JSON.stringify({ email: 'one@nsnzd.com' })]);
  const f2 = tmpFile([JSON.stringify({ email: 'two@nsnzd.com', username: 'nsnzd-x1' })]);
  const used = id.loadUsed({ files: [f1, f2] });
  assert.ok(used.emails.has('one@nsnzd.com'));
  assert.ok(used.emails.has('two@nsnzd.com'));
  assert.ok(used.usernames.has('nsnzd-x1'));
});
