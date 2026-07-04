const fs = require('fs');
const path = require('path');

function defaultCookieFile(rootDir = process.cwd()) {
  return path.join(rootDir, 'data', 'github-cookies.json');
}

function defaultCookieDir(rootDir = process.cwd()) {
  return path.join(rootDir, 'data', 'github-cookies');
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

module.exports = {
  defaultCookieFile,
  defaultCookieDir,
  listCookieFiles,
  loadCookies,
  deleteCookieFile,
  saveCookies,
};
