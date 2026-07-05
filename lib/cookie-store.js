const fs = require('fs');
const path = require('path');

function defaultCookieFile(rootDir = process.cwd()) {
  return path.join(rootDir, 'data', 'github-cookies.json');
}

function defaultCookieDir(rootDir = process.cwd()) {
  return path.join(rootDir, 'data', 'github-cookies');
}

function formatUtcTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join('');
}

function normalizeFilePart(text, fallback = 'github') {
  return String(text || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || fallback;
}

function uniqueExistingFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    if (!file) continue;
    const resolved = path.resolve(file);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

function listCookieFiles(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const explicitFile = opts.file || process.env.GITHUB_COOKIES_FILE || '';
  const cookieDir = opts.dir || process.env.GITHUB_COOKIES_DIR || defaultCookieDir(rootDir);
  const legacyFile = defaultCookieFile(rootDir);

  const files = [];
  if (explicitFile) files.push(explicitFile);
  if (fs.existsSync(cookieDir)) {
    for (const name of fs.readdirSync(cookieDir).sort()) {
      if (name.endsWith('.json')) files.push(path.join(cookieDir, name));
    }
  }
  files.push(legacyFile);
  return uniqueExistingFiles(files);
}

function loadCookies(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.cookies)) return parsed.cookies;
  throw new Error(`invalid cookies file: ${file}`);
}

function deleteCookieFile(file) {
  if (!file) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function saveCookies(file, cookies) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cookies || [], null, 2));
  return file;
}

function saveGithubSession(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const cookies = opts.cookies || [];
  const primary = opts.file || process.env.GITHUB_COOKIES_FILE || defaultCookieFile(rootDir);
  const archiveDir = opts.dir || process.env.GITHUB_COOKIES_DIR || defaultCookieDir(rootDir);
  const tag = `${formatUtcTimestamp(opts.now || new Date())}-${normalizeFilePart(opts.username || opts.email || 'github')}.json`;
  const archive = path.join(archiveDir, tag);

  saveCookies(primary, cookies);
  if (path.resolve(primary) !== path.resolve(archive)) {
    saveCookies(archive, cookies);
  }
  return { primary, archive };
}

function shouldDeleteGithubCookies(env = process.env) {
  if (env.DELETE_GITHUB_COOKIES_AFTER_USE === 'true') return true;
  if (env.KEEP_GITHUB_COOKIES === 'false') return true;
  return false;
}

module.exports = {
  defaultCookieFile,
  defaultCookieDir,
  shouldDeleteGithubCookies,
  listCookieFiles,
  loadCookies,
  deleteCookieFile,
  saveGithubSession,
  saveCookies,
};
