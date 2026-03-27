'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

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

// ── Setup user home directory ─────────────────────────────────────────────────

function setupUserDir(username, uid) {
  const home = `/data/users/${username}`;
  const claudeDir = path.join(home, '.claude');
  const projectsDir = path.join(home, 'projects');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  // Symlink global claude settings (read-only for user processes)
  const settingsLink = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsLink)) {
    try { fs.symlinkSync('/etc/claude/settings.json', settingsLink); } catch {}
  }

  // Ownership so the process (running as uid) can write
  try {
    fs.chownSync(home, uid, uid);
    fs.chownSync(claudeDir, uid, uid);
    fs.chownSync(projectsDir, uid, uid);
    // The symlink target (/etc/claude/settings.json) stays root-owned (644)
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

  const env = {
    HOME: `/data/users/${username}`,
    SERVER_PORT: String(port),
    HOST: '127.0.0.1',
    IS_PLATFORM: 'true',                // bypass claudecodeui's own auth
    WORKSPACES_ROOT: `/data/users/${username}/projects`,
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NODE_ENV: 'production',
    // Local LLM config (inherited from gateway env)
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
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
  sessions.set(username, session);

  proc.on('exit', (code) => {
    logStream.end();
    releasePort(port);
    sessions.delete(username);
    console.log(`[pm] ${username} exited (code ${code})`);
  });

  try {
    await waitForPort(port, 30000);
    console.log(`[pm] ${username} started on port ${port}`);
  } catch (err) {
    proc.kill();
    throw err;
  }

  return port;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getOrStart(username, uid) {
  const existing = sessions.get(username);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing.port;
  }
  return startProcess(username, uid);
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

module.exports = { getOrStart, killUser, getActiveSessions, setupUserDir };
