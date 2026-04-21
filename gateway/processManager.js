'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT_START = 10000;
const PORT_END = 11000;
const TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30', 10) * 60 * 1000;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '0', 10);
const LOG_DIR = '/var/lib/multiuser-ccui/logs';

// username → { port, proc, lastActivity }
const sessions = new Map();
const usedPorts = new Set();

// ── Port allocation ──────────────────────────────────────────────────────────

function allocatePort() {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('No free ports available (all sessions are active)');
}

function releasePort(port) {
  usedPorts.delete(port);
}

// ── Initialize ClaudeCodeUI user in platform mode ────────────────────────────
// In platform mode ClaudeCodeUI uses getFirstUser() for every request.
// If the DB is empty (fresh HOME dir), every API call returns 500 → white screen.
// /api/auth/register is open only when no users exist, so we call it once.

async function initializePlatformUser(port, username) {
  const base = `http://127.0.0.1:${port}`;
  try {
    // Create user (only succeeds when DB is empty; 403 = already exists, that's fine)
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: crypto.randomBytes(16).toString('hex'),
      }),
    });
    if (reg.ok) {
      console.log(`[pm] platform user initialized for ${username}`);
    } else if (reg.status !== 403) {
      const data = await reg.json().catch(() => ({}));
      console.warn(`[pm] platform user init warning for ${username}: ${reg.status}`, data.error || '');
    }

    // Mark onboarding complete so the UI doesn't show the git-config wizard.
    // In platform mode authenticateToken uses getFirstUser(), so no token needed.
    // This call is idempotent — safe to repeat on every session restart.
    await fetch(`${base}/api/user/complete-onboarding`, { method: 'POST' });
  } catch (err) {
    console.warn(`[pm] platform user init error for ${username}:`, err.message);
  }
}

// ── Wait for TCP port to accept connections ──────────────────────────────────

function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function tryConnect() {
      const sock = net.createConnection(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        if (Date.now() >= deadline) return reject(new Error(`Timeout waiting for port ${port}`));
        setTimeout(tryConnect, 250);
      });
    }
    tryConnect();
  });
}

// ── System user entries (/etc/passwd, /etc/group) ────────────────────────────
// Non-admin user processes run as dynamically allocated UIDs (10000+) that have
// no entries in /etc/passwd.  When the ClaudeCodeUI terminal plugin spawns a
// login shell for such a UID, bash calls getpwuid() to resolve HOME.  Without a
// passwd entry the lookup fails and HOME may be reset to '/' or left undefined,
// so `claude` cannot find ~/.claude/settings.json and never reads the env
// section (ANTHROPIC_BASE_URL, etc.) from it.
// Admin users run as uid=0 (root) which always has a passwd entry → works fine.

function ensureSystemUser(username, uid) {
  if (uid === 0) return; // root already exists in /etc/passwd
  const home = `/data/users/${username}`;
  const passwdEntry = `${username}:x:${uid}:${uid}::${home}:/bin/bash\n`;
  const groupEntry  = `${username}:x:${uid}:\n`;

  for (const [file, entry] of [['/etc/passwd', passwdEntry], ['/etc/group', groupEntry]]) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const alreadyPresent = content.split('\n').some(line => {
        const parts = line.split(':');
        return parts[0] === username || (parts[2] !== undefined && parts[2] === String(uid));
      });
      if (!alreadyPresent) {
        // O_APPEND (flag 'a') guarantees atomic append on POSIX, so concurrent
        // registrations don't interleave partial lines in /etc/passwd or /etc/group.
        const fd = fs.openSync(file, 'a');
        try { fs.writeSync(fd, entry); } finally { fs.closeSync(fd); }
      }
    } catch (e) {
      console.warn(`[pm] ${file} update warning for ${username}:`, e.message);
    }
  }
}

// Remove a user's entry from passwd-style files by parsing each line's first
// field.  Using startsWith() is unsafe: a valid username cannot contain ':',
// but commented or malformed lines could still confuse a prefix match.
function removeSystemUser(username) {
  if (!username) return;
  for (const file of ['/etc/passwd', '/etc/group', '/etc/shadow']) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const endsWithNewline = content.endsWith('\n');
      const lines = content.split('\n');
      const filtered = lines.filter(line => {
        if (!line) return true; // preserve trailing empty element from split
        const name = line.split(':', 1)[0];
        return name !== username;
      });
      let out = filtered.join('\n');
      if (endsWithNewline && !out.endsWith('\n')) out += '\n';
      fs.writeFileSync(file, out);
    } catch { /* file may not exist or be unwritable – safe to skip */ }
  }
}

// ── Setup user home directory ─────────────────────────────────────────────────

// Recursively change ownership of a directory tree to (uid, gid) *lazily*:
// only issue lchown when an entry's current uid/gid differ from the target.
// Uses lchown so symlinks are re-owned without following them (the target of
// a symlink into /etc/claude must stay root-owned).  Silently skips entries
// that cannot be stat'd or chown'd to keep session startup robust against
// partial damage.
//
// The lazy check (stat first, chown only if wrong) keeps the cost near zero
// when the home is already correctly owned — stat() is ~1µs per entry, so a
// project with 10k files still takes <50ms.  When something is actually
// wrong, only the stale subset is touched.
function chownRecursiveLazy(dirPath, uid, gid) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      const st = fs.lstatSync(full);
      if (st.uid !== uid || st.gid !== gid) {
        fs.lchownSync(full, uid, gid);
      }
    } catch {}
    // Recurse into real directories only — not symlinks to directories, to
    // avoid escaping the user's home via a symlink pointing at /etc/claude.
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      chownRecursiveLazy(full, uid, gid);
    }
  }
}

// Fix ownership of any stale entries inside the user's home.  Runs
// unconditionally on every session start because the original guarded version
// (fixOwnershipIfStale) was dead code: setupUserDir always chowns the
// top-level home right before this runs, so the `st.uid === uid` check always
// bailed out — leaving subdirectories (created by root during bind-mount
// setup, by an admin impersonating into the user's workspace, or by
// tar/rsync/cp without --numeric-ids) with the wrong owner.  The lazy walk
// keeps the common "already correct" case O(N stat) with zero chown syscalls.
//
// Without this the agent (running as the user's uid) would fail to create
// files inside subdirectories it doesn't own, which surfaced as "the agent
// can't create files until I chmod -R 777 the workspace".
function fixUserHomeOwnership(home, uid) {
  chownRecursiveLazy(home, uid, uid);
}

function setupUserDir(username, uid) {
  // Ensure the OS user database knows about this uid so that bash login shells
  // (spawned by the ClaudeCodeUI terminal plugin) can resolve HOME correctly.
  ensureSystemUser(username, uid);

  const home = `/data/users/${username}`;
  const claudeDir = path.join(home, '.claude');
  const projectsDir = path.join(home, 'projects');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  // Ensure `linkPath` is a symlink pointing at `target`.  Rebuilds the link
  // whenever the target is wrong or the path is a regular file/dir (this is
  // what happens when /data is copied with a tool that dereferences symlinks,
  // e.g. rsync without -l, or cp without -a).
  const ensureSymlink = (linkPath, target, rmRecursive = false) => {
    try {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        try {
          if (fs.readlinkSync(linkPath) === target) return; // already correct
        } catch {}
        fs.rmSync(linkPath, { force: true });
      } else {
        fs.rmSync(linkPath, { force: true, recursive: rmRecursive });
      }
    } catch { /* ENOENT: nothing to clean up */ }
    try { fs.symlinkSync(target, linkPath); } catch {}
  };

  // Symlink global claude assets (read-only for user processes).  The target
  // of each symlink stays root-owned (mode 755/644) so user processes can
  // read it but can't accidentally overwrite the shared state.
  ensureSymlink(path.join(claudeDir, 'settings.json'), '/etc/claude/settings.json');
  ensureSymlink(path.join(claudeDir, 'CLAUDE.md'),     '/etc/claude/CLAUDE.md');
  ensureSymlink(path.join(claudeDir, 'agents'),        '/etc/claude/agents',  true);
  ensureSymlink(path.join(claudeDir, 'skills'),        '/etc/claude/skills',  true);
  ensureSymlink(path.join(claudeDir, 'plugins'),       '/etc/claude/plugins', true);

  // Symlink global .claude-code-ui/plugins directory (shared across all users).
  const codeUiDir = path.join(home, '.claude-code-ui');
  fs.mkdirSync(codeUiDir, { recursive: true });
  ensureSymlink(path.join(codeUiDir, 'plugins'), '/etc/claude-code-ui/plugins', true);

  // Create per-user .gitconfig so git works out of the box.
  // If user already has stored settings, apply them; otherwise write defaults.
  const gitconfigPath = path.join(home, '.gitconfig');
  if (!fs.existsSync(gitconfigPath)) {
    let storedSettings = {};
    try {
      const db = require('./db');
      const dbUser = db.findByUsername(username);
      if (dbUser) storedSettings = db.getUserSettings(dbUser.id);
    } catch {}

    try {
      const { writeUserGitconfig } = require('./userGitConfig');
      writeUserGitconfig(username, storedSettings);
    } catch (e) {
      console.warn(`[pm] gitconfig write warning for ${username}:`, e.message);
    }
  }

  // Ownership so the process (running as uid) can write
  try {
    fs.chownSync(home, uid, uid);
    fs.chownSync(claudeDir, uid, uid);
    fs.chownSync(projectsDir, uid, uid);
    fs.chownSync(codeUiDir, uid, uid);
    // The symlink target (/etc/claude/settings.json) stays root-owned (644)
    if (fs.existsSync(gitconfigPath)) fs.chownSync(gitconfigPath, uid, uid);
  } catch (e) {
    console.warn(`[pm] chown warning for ${username}:`, e.message);
  }

  // Recover from ownership damage caused by (a) moving /data to a different
  // host (tar/rsync/cp without --numeric-ids, or numeric uid collisions
  // between hosts), (b) files seeded by root during bind-mount init, or (c)
  // admin impersonating the user's workspace.  Lazy walk: O(N stat) with zero
  // chown syscalls when everything is already correct.
  fixUserHomeOwnership(home, uid);
}

// ── Start a claudecodeui process for a user ───────────────────────────────────

async function startProcess(username, uid) {
  if (MAX_SESSIONS > 0 && sessions.size >= MAX_SESSIONS) {
    throw new Error('Maximum concurrent session limit reached');
  }

  setupUserDir(username, uid);

  const port = allocatePort();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logStream = fs.createWriteStream(path.join(LOG_DIR, `${username}.log`), { flags: 'a' });

  // Include the system npm global lib in NODE_PATH so plugin build steps can
  // find packages like @anthropic-ai/claude-code that are installed at the
  // system npm prefix (/usr/local/lib/node_modules).
  const sysNpmGlobal = '/usr/local/lib/node_modules';
  const nodePath = process.env.NODE_PATH
    ? `${sysNpmGlobal}:${process.env.NODE_PATH}`
    : sysNpmGlobal;

  const env = {
    HOME: `/data/users/${username}`,
    // Explicitly point git to the user-specific gitconfig so that url.insteadOf
    // redirect and GitLab oauth2-token rules are always honoured, even if some
    // code path inside ClaudeCodeUI inadvertently changes HOME at runtime.
    GIT_CONFIG_GLOBAL: `/data/users/${username}/.gitconfig`,
    SERVER_PORT: String(port),
    HOST: '127.0.0.1',
    VITE_IS_PLATFORM: 'true',           // bypass claudecodeui's own auth
    WORKSPACES_ROOT: `/data/users/${username}/projects`,
    // Language servers and Qt5 are installed in the image — process.env.PATH
    // already contains all needed dirs (set by entrypoint.sh).
    // /etc/claude/npm-global/bin — plugin binaries installed via admin panel.
    PATH: '/etc/claude/npm-global/bin:' +
          (process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
    // Allow plugin build steps (npm run build) to resolve global node modules.
    NODE_PATH: nodePath,
    ...(process.env.LD_LIBRARY_PATH && { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH }),
    ...(process.env.CUDA_HOME && { CUDA_HOME: process.env.CUDA_HOME }),
    NODE_ENV: 'production',
    // LLM endpoint config must be in process.env before ClaudeCodeUI starts so
    // that the claude CLI binary picks it up at SDK initialisation time (the
    // Anthropic Node SDK reads ANTHROPIC_BASE_URL once when the module loads,
    // before settings.json env-section values are applied).
    // Priority: /etc/claude/settings.json (admin UI) > docker-compose env vars.
    // This means changes made through the admin settings panel take effect for
    // all users on their next session start without redeploying the container.
    ...((() => {
      const sEnv = (() => {
        try { return JSON.parse(fs.readFileSync('/etc/claude/settings.json', 'utf8')).env || {}; }
        catch { return {}; }
      })();
      const baseUrl = sEnv.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
      const apiKey  = sEnv.ANTHROPIC_API_KEY  || process.env.ANTHROPIC_API_KEY;
      return {
        ...(baseUrl && { ANTHROPIC_BASE_URL: baseUrl }),
        ...(apiKey  && { ANTHROPIC_API_KEY:  apiKey  }),
      };
    })()),
    // Git proxy (lowercase variants are used by curl/git/npm)
    ...(process.env.GIT_PROXY_URL && {
      http_proxy: process.env.GIT_PROXY_URL,
      https_proxy: process.env.GIT_PROXY_URL,
      HTTP_PROXY: process.env.GIT_PROXY_URL,
      HTTPS_PROXY: process.env.GIT_PROXY_URL,
    }),
    ...(process.env.HTTP_PROXY && !process.env.GIT_PROXY_URL && {
      http_proxy: process.env.HTTP_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
    }),
    ...(process.env.HTTPS_PROXY && !process.env.GIT_PROXY_URL && {
      https_proxy: process.env.HTTPS_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
    }),
    ...(process.env.NO_PROXY && {
      no_proxy: process.env.NO_PROXY,
      NO_PROXY: process.env.NO_PROXY,
    }),
  };

  const proc = spawn('node', ['/opt/claudecodeui/server/index.js'], {
    cwd: `/data/users/${username}/projects`,
    uid,
    gid: uid,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  const session = { port, proc, lastActivity: Date.now() };
  // Register the session right away so that: (a) touchSession() during
  // initializePlatformUser counts as activity and (b) if the child process
  // exits early, the exit handler can delete it.  Without this, a process
  // that died between waitForPort and sessions.set would leak its entry.
  sessions.set(username, session);

  proc.on('exit', (code) => {
    logStream.end();
    releasePort(port);
    // Only remove *our* session entry — if killUser already replaced it with a
    // newer start, leave the new one alone.
    if (sessions.get(username) === session) sessions.delete(username);
    console.log(`[pm] ${username} exited (code ${code})`);
  });

  try {
    await waitForPort(port, 30000);
    await initializePlatformUser(port, username);
    session.lastActivity = Date.now();
    console.log(`[pm] ${username} started on port ${port}`);
  } catch (err) {
    // exit handler will release the port and delete the session entry
    try { proc.kill(); } catch {}
    throw err;
  }

  return port;
}

// ── Public API ────────────────────────────────────────────────────────────────

// username → Promise<number> while process is starting up
const _starting = new Map();

async function getOrStart(username, uid) {
  const existing = sessions.get(username);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing.port;
  }

  // Deduplicate concurrent start requests for the same user
  if (_starting.has(username)) {
    return _starting.get(username);
  }

  const promise = startProcess(username, uid).finally(() => {
    _starting.delete(username);
  });
  _starting.set(username, promise);
  return promise;
}

function killUser(username) {
  const session = sessions.get(username);
  if (session) {
    sessions.delete(username); // remove immediately so no new requests proxy here
    session.proc.kill('SIGTERM'); // exit handler will release the port
    console.log(`[pm] killed session for ${username}`);
  }
}

function deleteUserDir(username) {
  removeSystemUser(username);
  const home = `/data/users/${username}`;
  try {
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`[pm] deleted home dir for ${username}`);
  } catch (e) {
    console.warn(`[pm] failed to delete home dir for ${username}:`, e.message);
  }
}

function getActiveSessions() {
  const result = [];
  for (const [username, s] of sessions) {
    result.push({
      username,
      port: s.port,
      pid: s.proc.pid,
      idleSeconds: Math.floor((Date.now() - s.lastActivity) / 1000),
    });
  }
  return result;
}

// ── Idle session cleanup ──────────────────────────────────────────────────────

// Give late-arriving activity a grace window: a request that lands right
// between the sweep and killUser would otherwise be racing the SIGTERM.
const IDLE_GRACE_MS = 5_000;

setInterval(() => {
  const now = Date.now();
  for (const [username, s] of sessions) {
    if (now - s.lastActivity <= TIMEOUT_MS) continue;
    // Re-read the entry to ensure it wasn't touched while we were iterating
    // (Map iteration is synchronous, but subsequent loop bodies are not, and
    // getOrStart/touchSession may run before we reach the kill call below).
    const current = sessions.get(username);
    if (!current || current !== s) continue;
    if (Date.now() - current.lastActivity <= TIMEOUT_MS + IDLE_GRACE_MS) continue;
    console.log(`[pm] idle timeout for ${username}`);
    killUser(username);
  }
}, 60_000);

function touchSession(username) {
  const s = sessions.get(username);
  if (s) s.lastActivity = Date.now();
}

module.exports = { getOrStart, killUser, deleteUserDir, getActiveSessions, setupUserDir, touchSession };
