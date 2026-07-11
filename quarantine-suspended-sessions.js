#!/usr/bin/env node
'use strict';

const path = require('path');
const store = require('./lib/session-store');

function isSuspendedText(value) {
  const msg = String(value || '');
  return /account\s+(?:has\s+been\s+)?suspended/i.test(msg) ||
    /github_(?:account_)?suspended/i.test(msg);
}

function isolateSuspendedSessions(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const dryRun = !!opts.dryRun;
  const emailFilter = String(opts.email || '').trim().toLowerCase();
  const log = opts.log === false ? () => {} : (opts.log || console.log);
  const all = store.listSessions({ rootDir });
  const suspendedFile = store.defaultSuspendedFile(rootDir);
  const isolatedEmails = new Set(
    store.listSuspendedSessions({ rootDir }).map(s => String(s.email || '').toLowerCase()).filter(Boolean)
  );

  let matched = 0;
  let quarantined = 0;
  let copied = 0;

  for (const session of all) {
    const emailKey = String(session.email || '').toLowerCase();
    if (emailFilter && emailKey !== emailFilter) continue;
    const alreadySuspended = session.status === store.SUSPENDED_STATUS;
    const forceEmail = !!emailFilter;
    const looksSuspended = forceEmail || alreadySuspended || isSuspendedText(session.last_error) || isSuspendedText(session.status);
    if (!looksSuspended || !emailKey) continue;
    matched += 1;

    if (dryRun) {
      log(`[dry-run] ${session.email} → ${store.SUSPENDED_STATUS}`);
      continue;
    }

    if (alreadySuspended) {
      if (!isolatedEmails.has(emailKey)) {
        store.appendSuspendedSession(session, { rootDir });
        isolatedEmails.add(emailKey);
        copied += 1;
      }
      continue;
    }

    store.quarantineSuspendedSession(session.email, {
      last_error: session.last_error || (forceEmail ? 'manual_github_suspended_quarantine' : 'github_account_suspended'),
    }, { rootDir });
    isolatedEmails.add(emailKey);
    quarantined += 1;
  }

  const out = { scanned: all.length, matched, quarantined, copied, dryRun, suspendedFile };
  log(`[quarantine-suspended] scanned=${out.scanned} matched=${out.matched} quarantined=${out.quarantined} copied=${out.copied} file=${path.relative(rootDir, suspendedFile) || suspendedFile}`);
  return out;
}

function argValue(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? (argv[idx + 1] || '') : '';
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const email = argValue(argv, '--email');
  const out = isolateSuspendedSessions({ rootDir: __dirname, dryRun, email });
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = {
  isSuspendedText,
  isolateSuspendedSessions,
  argValue,
  main,
};
