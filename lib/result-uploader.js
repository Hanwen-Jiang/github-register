const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

function normalizeResult(result, meta = {}) {
  return {
    ...result,
    uploaded_at: new Date().toISOString(),
    meta,
  };
}

function appendLocalResult(result, opts = {}) {
  const file = opts.file || process.env.RESULT_LOCAL_FILE || path.join(process.cwd(), 'data', 'results.jsonl');
  if (String(file).toLowerCase() === 'off') return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
  return file;
}

async function uploadHttpResult(result, opts = {}) {
  const url = opts.url || process.env.RESULT_UPLOAD_URL || '';
  if (!url) return null;
  const token = opts.token || process.env.RESULT_UPLOAD_TOKEN || '';
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(parseInt(process.env.RESULT_UPLOAD_TIMEOUT_MS || '30000', 10)),
  });
  if (!resp.ok) {
    throw new Error(`result http upload failed: ${resp.status} ${String(await resp.text()).slice(0, 300)}`);
  }
  return { url, status: resp.status };
}

function uploadSshResult(result, opts = {}) {
  const remotePath = opts.remotePath || process.env.RESULT_REMOTE_PATH || '';
  if (!remotePath) return null;
  const remote = opts.remote || process.env.RESULT_REMOTE_SSH || process.env.REMOTE_SSH || 'root@186.244.238.119';
  const key = opts.key || process.env.RESULT_REMOTE_SSH_KEY || process.env.REMOTE_SSH_KEY || `${process.env.HOME}/.ssh/jhw.pem`;
  const line = JSON.stringify(result);
  const script = `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && printf %s\\\\n ${shellQuote(line)} >> ${shellQuote(remotePath)}`;
  const args = [
    '-i', key,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    remote,
    script,
  ];
  execFileSync('ssh', args, { encoding: 'utf8', timeout: parseInt(process.env.RESULT_REMOTE_TIMEOUT_MS || '45000', 10) });
  return { remote, remotePath };
}

async function uploadResult(result, opts = {}) {
  const normalized = normalizeResult(result, opts.meta || {});
  const localFile = appendLocalResult(normalized, opts);
  const uploads = { localFile, http: null, ssh: null };
  uploads.http = await uploadHttpResult(normalized, opts).catch(err => {
    if (opts.strict) throw err;
    return { error: err.message };
  });
  uploads.ssh = (() => {
    try {
      return uploadSshResult(normalized, opts);
    } catch (err) {
      if (opts.strict) throw err;
      return { error: err.message };
    }
  })();
  return uploads;
}

module.exports = {
  normalizeResult,
  appendLocalResult,
  uploadHttpResult,
  uploadSshResult,
  uploadResult,
};
