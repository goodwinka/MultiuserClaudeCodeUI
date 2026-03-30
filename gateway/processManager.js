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
      if (!alreadyPresent) fs.appendFileSync(file, entry);
    } catch (e) {
      console.warn(`[pm] ${file} update warning for ${username}:`, e.message);
    }
  }
}

function removeSystemUser(username) {
  if (!username) return;
  for (const file of ['/etc/passwd', '/etc/group', '/etc/shadow']) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const filtered = content.split('\n')
        .filter(line => !line.startsWith(username + ':'))
        .join('\n');
      fs.writeFileSync(file, filtered);
    } catch { /* file may not exist or be unwritable – safe to skip */ }
  }
}

// ── Setup user home directory ─────────────────────────────────────────────────

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

  // Symlink global claude settings (read-only for user processes)
  const settingsLink = path.join(claudeDir, 'settings.json');
  const settingsIsSymlink = (() => { try { return fs.lstatSync(settingsLink).isSymbolicLink(); } catch { return false; } })();
  if (!settingsIsSymlink) {
    try {
      if (fs.existsSync(settingsLink)) fs.rmSync(settingsLink, { force: true });
      fs.symlinkSync('/etc/claude/settings.json', settingsLink);
    } catch {}
  }

  // Symlink global CLAUDE.md (read-only for user processes)
  const claudeMdLink = path.join(claudeDir, 'CLAUDE.md');
  const claudeMdIsSymlink = (() => { try { return fs.lstatSync(claudeMdLink).isSymbolicLink(); } catch { return false; } })();
  if (!claudeMdIsSymlink) {
    try {
      if (fs.existsSync(claudeMdLink)) fs.rmSync(claudeMdLink, { force: true });
      fs.symlinkSync('/etc/claude/CLAUDE.md', claudeMdLink);
    } catch {}
  }

  // Symlink global agents directory (read-only for user processes)
  const agentsLink = path.join(claudeDir, 'agents');
  const agentsIsSymlink = (() => { try { return fs.lstatSync(agentsLink).isSymbolicLink(); } catch { return false; } })();
  if (!agentsIsSymlink) {
    try {
      if (fs.existsSync(agentsLink)) fs.rmSync(agentsLink, { recursive: true, force: true });
      fs.symlinkSync('/etc/claude/agents', agentsLink);
    } catch {}
  }

  // Symlink global skills directory (read-only for user processes)
  const skillsLink = path.join(claudeDir, 'skills');
  const skillsIsSymlink = (() => { try { return fs.lstatSync(skillsLink).isSymbolicLink(); } catch { return false; } })();
  if (!skillsIsSymlink) {
    try {
      if (fs.existsSync(skillsLink)) fs.rmSync(skillsLink, { recursive: true, force: true });
      fs.symlinkSync('/etc/claude/skills', skillsLink);
    } catch {}
  }

  // Symlink global plugins directory (read-only for user processes).
  // Use lstat to distinguish a real symlink from a plain directory that
  // Claude Code may have created during an earlier session.
  const pluginsLink = path.join(claudeDir, 'plugins');
  const pluginsIsSymlink = (() => { try { return fs.lstatSync(pluginsLink).isSymbolicLink(); } catch { return false; } })();
  if (!pluginsIsSymlink) {
    try {
      if (fs.existsSync(pluginsLink)) fs.rmSync(pluginsLink, { recursive: true, force: true });
      fs.symlinkSync('/etc/claude/plugins', pluginsLink);
    } catch {}
  }

  // Symlink global .claude-code-ui/plugins directory (shared across all users).
  const codeUiDir = path.join(home, '.claude-code-ui');
  fs.mkdirSync(codeUiDir, { recursive: true });
  const codeUiPluginsLink = path.join(codeUiDir, 'plugins');
  const codeUiPluginsIsSymlink = (() => { try { return fs.lstatSync(codeUiPluginsLink).isSymbolicLink(); } catch { return false; } })();
  if (!codeUiPluginsIsSymlink) {
    try {
      if (fs.existsSync(codeUiPluginsLink)) fs.rmSync(codeUiPluginsLink, { recursive: true, force: true });
      fs.symlinkSync('/etc/claude-code-ui/plugins', codeUiPluginsLink);
    } catch {}
  }

  // Create per-user .gitconfig so git works out of the box
  const gitconfigPath = path.join(home, '.gitconfig');
  if (!fs.existsSync(gitconfigPath)) {
    let gitconfig = `[user]\n\tname = ${username}\n\temail = ${username}@localhost\n`;
    // If a git proxy is configured, include it so user processes inherit it
    const proxyUrl = process.env.GIT_PROXY_URL || process.env.HTTP_PROXY || '';
    if (proxyUrl) {
      gitconfig += `[http]\n\tproxy = ${proxyUrl}\n`;
    }
    try {
      fs.writeFileSync(gitconfigPath, gitconfig, { mode: 0o644 });
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
    // Local LLM config (inherited from gateway env).
    // Only set when actually configured — an empty string would shadow the
    // value in ~/.claude/settings.json env section and break non-admin shells.
    ...(process.env.ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }),
    ...(process.env.ANTHROPIC_API_KEY  && { ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  }),
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

  proc.on('exit', (code) => {
    logStream.end();
    releasePort(port);
    sessions.delete(username);
    console.log(`[pm] ${username} exited (code ${code})`);
  });

  try {
    await waitForPort(port, 30000);
    await initializePlatformUser(port, username);
    sessions.set(username, session);
    console.log(`[pm] ${username} started on port ${port}`);
  } catch (err) {
    proc.kill();
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
    session.proc.kill('SIGTERM');
    sessions.delete(username);
    releasePort(session.port);
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

setInterval(() => {
  const now = Date.now();
  for (const [username, s] of sessions) {
    if (now - s.lastActivity > TIMEOUT_MS) {
      console.log(`[pm] idle timeout for ${username}`);
      killUser(username);
    }
  }
}, 60_000);

module.exports = { getOrStart, killUser, deleteUserDir, getActiveSessions, setupUserDir };
