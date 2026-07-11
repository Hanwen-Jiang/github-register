// lib/identity.js — playwright-free identity (email + GitHub username) generation
// with persistent de-duplication against historical records.
//
// Why this module exists:
//   The old inline generator in index.js produced `${given}.${surname}@nsnzd.com`
//   with NO random suffix (~3200 combinations) and de-duped only via an in-memory
//   Set that reset on every process restart — and the nsnzd.com branch didn't even
//   consult that Set. After ~117 accounts, "email already associated" collisions
//   were statistically inevitable (birthday paradox: first collision near √3200≈71).
//
// This module fixes it by:
//   1. Enlarging the local-part entropy: mixed separators (./_/none), name order,
//      and an OPTIONAL numeric suffix → ~millions of combinations.
//   2. Persistent de-dup: seeds "used" emails/usernames from data/results.jsonl and
//      data/sessions.jsonl so restarts don't regenerate old identities.
//
// Kept playwright-free on purpose so it is unit-testable locally (no node_modules).

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────────────────
// Name pools (expanded from the original index.js lists)
// ──────────────────────────────────────────────────────────
const SURNAMES = [
    'li', 'wang', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao',
    'wu', 'zhou', 'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he',
    'gao', 'lin', 'luo', 'liang', 'song', 'zheng', 'xie', 'han',
    'tang', 'feng', 'yu', 'dong', 'xiao', 'cheng', 'cao', 'yuan',
    'deng', 'fu', 'shen', 'zeng', 'peng', 'lu', 'su', 'jiang',
    'cai', 'jia', 'ding', 'wei', 'xue', 'ye', 'yan', 'pan', 'du',
    'dai', 'xia', 'zhong', 'wang2', 'tian', 'ren', 'jin', 'qiu',
    'hou', 'shi', 'meng', 'long', 'wan', 'duan', 'lei', 'qian',
];

const GIVEN_NAMES = [
    'alan', 'emma', 'james', 'lisa', 'david', 'sarah', 'michael',
    'jennifer', 'robert', 'amanda', 'william', 'jessica', 'richard',
    'elizabeth', 'joseph', 'michelle', 'thomas', 'stephanie', 'daniel',
    'amy', 'matthew', 'rachel', 'andrew', 'laura', 'kevin', 'megan',
    'jason', 'ashley', 'brian', 'kimberly', 'steven', 'melissa',
    'mark', 'rebecca', 'paul', 'katherine', 'george', 'christine',
    'kenneth', 'samantha', 'anthony', 'danielle', 'edward', 'heather',
    'ronald', 'amber', 'patrick', 'maria', 'jack', 'sandra', 'dennis',
    'olivia', 'jerry', 'victoria', 'tyler', 'natalie', 'aaron', 'grace',
    'henry', 'chloe', 'douglas', 'hannah', 'peter', 'isabella', 'frank',
    'zoe', 'adam', 'lily', 'nathan', 'ella', 'bryan', 'mia', 'sean',
    'sophia', 'ethan', 'ava', 'brandon', 'madison', 'alexander', 'layla',
    'ryan', 'sofia', 'eric', 'aria', 'justin', 'scarlett', 'gary', 'nora',
    'jacob', 'riley', 'tyler', 'aubrey', 'noah', 'zoey', 'lucas', 'lucy',
];

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// Normalize a name token: strip trailing disambiguation digits (e.g. "wang2"),
// lowercase, keep only a-z.
function cleanName(name) {
    return String(name || '').replace(/[0-9]+$/, '').replace(/[^a-z]/gi, '').toLowerCase();
}

// ──────────────────────────────────────────────────────────
// Email local-part: "mixed variants + optional digits" style.
//   separator ∈ {'.', '_', ''} · order ∈ {given+surname, surname+given}
//   ~55% of emails carry a 1-4 digit suffix (real inboxes commonly do).
// Combined space is in the millions, making collisions effectively impossible.
// ──────────────────────────────────────────────────────────
function generateLocalPart(opts = {}) {
    const rand = opts.rand || Math.random;
    const given = cleanName(opts.given || randomItem(GIVEN_NAMES));
    const surname = cleanName(opts.surname || randomItem(SURNAMES));
    const separators = ['.', '_', ''];
    const sep = separators[Math.floor(rand() * separators.length)];
    const [a, b] = rand() < 0.5 ? [given, surname] : [surname, given];
    let local = `${a}${sep}${b}`;
    // ~55% chance of a numeric suffix; 1-4 digits.
    if (rand() < 0.55) {
        const digits = 1 + Math.floor(rand() * 4);
        const max = Math.pow(10, digits);
        const num = Math.floor(rand() * max);
        local += String(num).padStart(1, '0'); // no leading-zero padding beyond 1 char
    }
    return local;
}

// ──────────────────────────────────────────────────────────
// Persistent de-dup: harvest previously-used emails/usernames.
// ──────────────────────────────────────────────────────────
function harvestFromJsonl(file, sink) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
        return; // missing file is fine
    }
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        } catch (_) {
            continue; // tolerate a corrupt line
        }
        if (obj && typeof obj.email === 'string') sink.emails.add(obj.email.toLowerCase());
        if (obj && typeof obj.username === 'string') sink.usernames.add(obj.username.toLowerCase());
    }
}

// Build the "used" sets from historical files. dataDir defaults to <rootDir>/data.
function loadUsed(opts = {}) {
    const rootDir = opts.rootDir || process.cwd();
    const dataDir = opts.dataDir || path.join(rootDir, 'data');
    const files = opts.files || [
        process.env.RESULT_LOCAL_FILE || path.join(dataDir, 'results.jsonl'),
        process.env.SESSIONS_FILE || path.join(dataDir, 'sessions.jsonl'),
    ];
    const sink = { emails: new Set(), usernames: new Set() };
    for (const f of files) {
        if (!f || String(f).toLowerCase() === 'off') continue;
        harvestFromJsonl(f, sink);
    }
    return sink;
}

// GitHub username: <given>-<surname><num>. Never use the reserved/internal
// "nsnzd-" prefix. num widens the space; dedup below guards against the rare
// collision.
function generateUsername(opts = {}) {
    const rand = opts.rand || Math.random;
    const given = cleanName(opts.given || randomItem(GIVEN_NAMES));
    const surname = cleanName(opts.surname || randomItem(SURNAMES));
    const num = Math.floor(1000 + rand() * 900000);
    return `${given}-${surname}${num}`.slice(0, 39).replace(/-+$/g, '');
}

// Generate an email whose local part is not in `used.emails`. Retries with fresh
// random parts; after `maxTries` falls back to appending more entropy so it can
// never loop forever.
function generateUniqueEmail(used, opts = {}) {
    const domain = opts.domain || 'nsnzd.com';
    const usedEmails = (used && used.emails) || new Set();
    const maxTries = opts.maxTries || 40;
    for (let i = 0; i < maxTries; i++) {
        const email = `${generateLocalPart(opts)}@${domain}`;
        if (!usedEmails.has(email.toLowerCase())) return email;
    }
    // Escape hatch: force high-entropy suffix.
    const local = `${generateLocalPart(opts)}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    return `${local}@${domain}`;
}

function generateUniqueUsername(used, opts = {}) {
    const usedNames = (used && used.usernames) || new Set();
    const maxTries = opts.maxTries || 40;
    for (let i = 0; i < maxTries; i++) {
        const name = generateUsername(opts);
        if (!usedNames.has(name.toLowerCase())) return name;
    }
    return generateUsername(opts); // extremely unlikely; num range makes dupes rare
}

module.exports = {
    SURNAMES, GIVEN_NAMES, randomItem, cleanName, generateLocalPart,
    harvestFromJsonl, loadUsed, generateUsername,
    generateUniqueEmail, generateUniqueUsername,
};
