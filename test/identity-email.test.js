const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  generateIdentity,
  reserveEmail,
  buildRandomNsnzdEmail,
} = require('../index');

test('buildRandomNsnzdEmail includes a high-entropy suffix', () => {
  const email = buildRandomNsnzdEmail('alice', 'zhang', 'nsnzd.com');

  assert.match(email, /^alice\.zhang\.[a-z0-9]{6,}@nsnzd\.com$/);
});

test('generateIdentity does not reuse fallback emails in a large local batch', () => {
  const oldDefaultPassword = process.env.DEFAULT_PASSWORD;
  const oldSignupEmail = process.env.SIGNUP_EMAIL;
  const oldCustomEmail = process.env.CUSTOM_EMAIL;
  const oldQQ = process.env.QQ_EMAIL_FILE;
  const oldReservation = process.env.EMAIL_RESERVATION_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reserve-'));
  process.env.DEFAULT_PASSWORD = 'Nsnzdtmdsj0913?';
  delete process.env.SIGNUP_EMAIL;
  delete process.env.CUSTOM_EMAIL;
  process.env.QQ_EMAIL_FILE = '/no/such/qq-email-file.txt';
  process.env.EMAIL_RESERVATION_FILE = path.join(dir, 'used-emails.jsonl');

  try {
    const emails = new Set();
    for (let i = 0; i < 1000; i += 1) {
      emails.add(generateIdentity().email);
    }
    assert.equal(emails.size, 1000);
  } finally {
    if (oldDefaultPassword === undefined) delete process.env.DEFAULT_PASSWORD; else process.env.DEFAULT_PASSWORD = oldDefaultPassword;
    if (oldSignupEmail === undefined) delete process.env.SIGNUP_EMAIL; else process.env.SIGNUP_EMAIL = oldSignupEmail;
    if (oldCustomEmail === undefined) delete process.env.CUSTOM_EMAIL; else process.env.CUSTOM_EMAIL = oldCustomEmail;
    if (oldQQ === undefined) delete process.env.QQ_EMAIL_FILE; else process.env.QQ_EMAIL_FILE = oldQQ;
    if (oldReservation === undefined) delete process.env.EMAIL_RESERVATION_FILE; else process.env.EMAIL_RESERVATION_FILE = oldReservation;
  }
});

test('reserveEmail prevents reuse across processes through a reservation file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-reserve-'));
  const file = path.join(dir, 'emails.jsonl');

  assert.equal(reserveEmail('a@nsnzd.com', { file }), true);
  assert.equal(reserveEmail('a@nsnzd.com', { file }), false);
  assert.equal(reserveEmail('b@nsnzd.com', { file }), true);
});
