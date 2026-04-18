// Shared helper that builds and writes /data/users/{username}/.gitconfig from
// stored user settings.  Used both by processManager.js (on first-time user
// setup) and by the settings-save handler in index.js (when the user edits
// their git identity / gitlab tokens / url redirects).
//
// Kept deliberately small — no DB access, no env I/O beyond process.env for
// the system-wide proxy/SSL options.

const fs = require('fs');
const path = require('path');

/**
 * Build the textual contents of a user's .gitconfig from stored settings.
 *
 * @param {string} username  Linux/project username (also fallback for user.name/user.email).
 * @param {object} settings  Stored user settings ({ git, gitlabs, urlRedirects }).
 * @returns {string} full gitconfig file content (ends with newline).
 */
function buildGitconfig(username, settings) {
  const s = settings || {};
  const git = s.git || {};
  const name = (git.name || '').trim() || username;
  const email = (git.email || '').trim() || `${username}@localhost`;

  let content = `[user]\n\tname = ${name}\n\temail = ${email}\n`;

  // Per-GitLab token entries via url.insteadOf
  const gitlabs = Array.isArray(s.gitlabs) ? s.gitlabs : [];
  for (const entry of gitlabs) {
    const rawUrl = (entry.url || '').trim().replace(/\/$/, '');
    const token = (entry.token || '').trim();
    if (!rawUrl || !token) continue;
    const authedUrl = rawUrl.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
    content += `[url "${authedUrl}/"]\n\tinsteadOf = ${rawUrl}/\n`;
  }

  // Generic URL redirects via url.insteadOf.
  // Normalise HTTP/HTTPS base URLs to always have a trailing slash so that
  // git's prefix-replacement logic produces a valid URL.
  const redirects = Array.isArray(s.urlRedirects) ? s.urlRedirects : [];
  for (const r of redirects) {
    let from = (r.from || '').trim();
    let to   = (r.to   || '').trim();
    if (!from || !to) continue;
    if (/^https?:\/\//i.test(from) && !from.endsWith('/')) from += '/';
    if (/^https?:\/\//i.test(to)   && !to.endsWith('/'))   to   += '/';
    content += `[url "${to}"]\n\tinsteadOf = ${from}\n`;
  }

  // System-level git proxy and SSL settings from environment
  const proxyUrl = process.env.GIT_PROXY_URL || process.env.HTTP_PROXY || '';
  const sslNoVerify = process.env.GIT_SSL_NO_VERIFY === 'true' || process.env.GIT_SSL_NO_VERIFY === '1';
  if (proxyUrl || sslNoVerify) {
    content += `[http]\n`;
    if (proxyUrl) content += `\tproxy = ${proxyUrl}\n`;
    if (sslNoVerify) content += `\tsslVerify = false\n`;
  }

  return content;
}

/**
 * Write .gitconfig for a user and chown it to the given uid (best-effort).
 *
 * @param {string} username
 * @param {object} settings  Stored user settings.
 * @param {number} [uid]     Linux uid to chown the file to; if omitted, chown is skipped.
 * @returns {string} path to the written .gitconfig
 */
function writeUserGitconfig(username, settings, uid) {
  const home = `/data/users/${username}`;
  const gitconfigPath = path.join(home, '.gitconfig');
  const content = buildGitconfig(username, settings);

  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(gitconfigPath, content, { mode: 0o644 });
  if (typeof uid === 'number') {
    try { fs.chownSync(gitconfigPath, uid, uid); } catch {}
  }
  return gitconfigPath;
}

module.exports = { buildGitconfig, writeUserGitconfig };
