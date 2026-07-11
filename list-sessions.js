#!/usr/bin/env node
// list-sessions.js — 查看 data/sessions.jsonl 里的已有 GitHub session。
//   node list-sessions.js            # 汇总 + 每个 session 一行
//   node list-sessions.js --json     # 输出去重后的完整 JSON
//   node list-sessions.js --reusable # 额外显示每个站点当前可自动复用的 session

const path = require('path');
const store = require('./lib/session-store');
const sites = require('./lib/sites');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const showReusable = argv.includes('--reusable');
const rootDir = __dirname;

const all = store.listSessions({ rootDir });

if (asJson) {
  console.log(JSON.stringify(all, null, 2));
  process.exit(0);
}

const active = all.filter(s => s.status === 'active');
const withKeys = all.filter(s => !s.empty_keys && s.last_result_keys > 0);
const statusCounts = all.reduce((acc, s) => {
  const k = s.status || 'unknown';
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

function hasGithubCookies(sess) {
  return (sess.storage_state?.cookies || []).some(c => {
    const d = String(c.domain || '').toLowerCase();
    return d === 'github.com' || d.endsWith('.github.com');
  });
}

console.log(`唯一 session 数(去重后): ${all.length}  |  active: ${active.length}  |  已产 key: ${withKeys.length}`);
console.log(`状态分布: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(' | ') || '(空)'}`);
console.log(`active 且带 GitHub cookies: ${active.filter(hasGithubCookies).length}`);
console.log('');
for (const s of all) {
  const sitesReg = Object.keys(s.sites_registered || {});
  console.log([
    s.email.padEnd(34),
    `status=${s.status}`.padEnd(15),
    `keys=${s.last_result_keys}`.padEnd(9),
    `empty=${s.empty_keys}`.padEnd(12),
    `站点=[${sitesReg.join(',')}]`,
  ].join(' '));
}

if (showReusable) {
  console.log('\n每个站点当前可用的 session（优先已产 key lead；没有就用 active GitHub session）:');
  for (const site of sites.resolveTargetSites()) {
    const r = store.findAvailableSession(site.name, { rootDir });
    const count = active.filter(s => hasGithubCookies(s) && !(s.sites_registered || {})[site.name]).length;
    console.log(`  ${site.name}: ${r ? r.email : '(无)'}  | 可投放数=${count}`);
  }
}
