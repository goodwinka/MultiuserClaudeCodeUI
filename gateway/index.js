'use strict';

require('express-async-errors');
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const httpProxy = require('http-proxy');
const path = require('path');
const fs = require('fs');

const { execFile } = require('child_process');

const db = require('./db');
const pm = require('./processManager');

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const GW = '/__gateway';          // gateway-specific route prefix

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
// Scope body parsing to gateway routes only — applying it globally would consume
// the request stream before http-proxy can forward POST bodies to ClaudeCodeUI.
app.use(GW, express.json());
app.use(GW, express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static assets for gateway pages (no external CDN)
app.use(GW + '/static', express.static(path.join(__dirname, 'public')));

// Local ESM bundles — offline CDN replacement for esm.sh.
// The proxyRes handler rewrites https://esm.sh/ → /__esm/ in all proxied
// JS/HTML responses, so the browser fetches these local files instead.
app.use('/__esm', express.static('/opt/esm-bundles', {
  setHeaders(res) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// ── JWT helpers ───────────────────────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function tokenFromReq(req) {
  return req.cookies?.token || req.headers['x-token'] || null;
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const user = verifyToken(tokenFromReq(req));
  if (!user) return res.redirect(GW + '/login');
  if (user.blocked) return res.redirect(GW + '/login?error=blocked');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = verifyToken(tokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  req.user = user;
  next();
}

function requireAdminPage(req, res, next) {
  const user = verifyToken(tokenFromReq(req));
  if (!user || user.role !== 'admin') return res.redirect(GW + '/login');
  req.user = user;
  next();
}

// ── Gateway pages ─────────────────────────────────────────────────────────────

app.get(GW + '/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.get(GW + '/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/register.html'));
});

app.get(GW + '/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// ── Auth API ──────────────────────────────────────────────────────────────────

app.post(GW + '/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.findByUsername((username || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.redirect(GW + '/login?error=invalid');
  }
  if (user.blocked) return res.redirect(GW + '/login?error=blocked');

  res.cookie('token', signToken({ id: user.id, username: user.username, role: user.role, uid: user.uid }), {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400 * 1000,
  });
  res.redirect('/');
});

app.post(GW + '/auth/register', (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.redirect(GW + '/register?error=invalid_username');
  }
  if (password.length < 6) {
    return res.redirect(GW + '/register?error=short_password');
  }
  if (db.findByUsername(username)) {
    return res.redirect(GW + '/register?error=exists');
  }

  const uid = db.nextUid();
  const hash = bcrypt.hashSync(password, 10);
  const user = db.createUser(username, hash, 'user', uid);

  pm.setupUserDir(username, uid);

  res.cookie('token', signToken({ id: user.id, username, role: 'user', uid }), {
    httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400 * 1000,
  });
  res.redirect('/');
});

app.post(GW + '/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect(GW + '/login');
});

// ── Admin API ─────────────────────────────────────────────────────────────────

app.get(GW + '/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post(GW + '/api/admin/users/:id/block', requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (user) pm.killUser(user.username);
  db.blockUser(req.params.id, 1);
  res.json({ ok: true });
});

app.post(GW + '/api/admin/users/:id/unblock', requireAdmin, (req, res) => {
  db.blockUser(req.params.id, 0);
  res.json({ ok: true });
});

app.delete(GW + '/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (user) {
    pm.killUser(user.username);
    pm.deleteUserDir(user.username);
  }
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

app.get(GW + '/api/admin/sessions', requireAdmin, (req, res) => {
  res.json(pm.getActiveSessions());
});

app.post(GW + '/api/admin/sessions/:username/kill', requireAdmin, (req, res) => {
  pm.killUser(req.params.username);
  res.json({ ok: true });
});

app.post(GW + '/api/admin/users', requireAdmin, (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!/^[a-z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Недопустимое имя пользователя' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Пароль слишком короткий (мин. 6 символов)' });
  if (db.findByUsername(username))
    return res.status(400).json({ error: 'Пользователь уже существует' });

  const uid = db.nextUid();
  const hash = bcrypt.hashSync(password, 10);
  const user = db.createUser(username, hash, role, uid);
  pm.setupUserDir(username, uid);
  res.json(user);
});

app.patch(GW + '/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  db.updateRole(req.params.id, role);
  res.json({ ok: true });
});

app.patch(GW + '/api/admin/users/:id/password', requireAdmin, (req, res) => {
  const password = req.body.password || '';
  if (password.length < 6)
    return res.status(400).json({ error: 'Пароль слишком короткий (мин. 6 символов)' });
  db.updatePassword(req.params.id, bcrypt.hashSync(password, 10));
  res.json({ ok: true });
});

// ── Global agents API ─────────────────────────────────────────────────────────

const AGENTS_DIR = '/etc/claude/agents';
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

app.get(GW + '/api/admin/agents', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    res.json(files.map(f => ({ name: f.slice(0, -3) })));
  } catch { res.json([]); }
});

app.get(GW + '/api/admin/agents/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    const content = fs.readFileSync(path.join(AGENTS_DIR, name + '.md'), 'utf8');
    res.json({ name, content });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

app.put(GW + '/api/admin/agents/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Content required' });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(AGENTS_DIR, name + '.md'), content, { mode: 0o644 });
  res.json({ ok: true });
});

app.delete(GW + '/api/admin/agents/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!AGENT_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    fs.unlinkSync(path.join(AGENTS_DIR, name + '.md'));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── Global skills API ─────────────────────────────────────────────────────────

const SKILLS_DIR = '/etc/claude/skills';
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

app.get(GW + '/api/admin/skills', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
    res.json(files.map(f => ({ name: f.slice(0, -3) })));
  } catch { res.json([]); }
});

app.get(GW + '/api/admin/skills/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    const content = fs.readFileSync(path.join(SKILLS_DIR, name + '.md'), 'utf8');
    res.json({ name, content });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

app.put(GW + '/api/admin/skills/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Content required' });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, name + '.md'), content, { mode: 0o644 });
  res.json({ ok: true });
});

app.delete(GW + '/api/admin/skills/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    fs.unlinkSync(path.join(SKILLS_DIR, name + '.md'));
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── Global settings API ───────────────────────────────────────────────────────

const SETTINGS_PATH = '/etc/claude/settings.json';

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}

function writeSettings(obj) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2) + '\n', { mode: 0o644 });
}

app.get(GW + '/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf8');
    res.json({ content });
  } catch { res.json({ content: '{}' }); }
});

app.put(GW + '/api/admin/settings', requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Content required' });
  try { JSON.parse(content); } catch { return res.status(400).json({ error: 'Некорректный JSON' }); }
  fs.writeFileSync(SETTINGS_PATH, content, { mode: 0o644 });
  syncMcpJson();
  res.json({ ok: true });
});

// ── Global CLAUDE.md API ──────────────────────────────────────────────────────

const CLAUDE_MD_PATH = '/etc/claude/CLAUDE.md';

app.get(GW + '/api/admin/claudemd', requireAdmin, (req, res) => {
  try {
    const content = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
    res.json({ content });
  } catch { res.json({ content: '' }); }
});

app.put(GW + '/api/admin/claudemd', requireAdmin, (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Content required' });
  fs.writeFileSync(CLAUDE_MD_PATH, content, { mode: 0o644 });
  res.json({ ok: true });
});

// ── Claude Code plugins API ───────────────────────────────────────────────────

// The global "home" whose .claude → /etc/claude, so `claude plugin` commands
// write/read from the shared /etc/claude/plugins directory.
const CLAUDE_GLOBAL_HOME = '/var/lib/claude-global';

// Resolve the `claude` binary at startup from PATH (works with any Node.js
// install location — avoids hard-coding paths like /opt/node22/bin/claude).
const CLAUDE_BIN = (() => {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'claude'; // fallback: let execFile search PATH itself
})();

// After any plugin install / uninstall / enable / disable, ensure all files
// under /etc/claude/plugins and /etc/claude/npm-global are world-readable and
// that native addons (.node) are world-executable.  Without this, non-root
// ClaudeCodeUI processes (uid 10000+) cannot load plugin assets or native
// modules, so the terminal plugin backend silently fails and the shell tab
// appears to have no settings.
function fixPluginPermissions() {
  const dirs = ['/etc/claude/plugins', '/etc/claude/npm-global'];
  for (const dir of dirs) {
    try {
      // Directories: world-readable + executable (listable)
      execFile('find', [dir, '-type', 'd', '-exec', 'chmod', 'a+rx', '{}', '+'],
        { timeout: 10000 }, () => {});
      // Regular files: world-readable
      execFile('find', [dir, '-type', 'f', '-exec', 'chmod', 'a+r', '{}', '+'],
        { timeout: 10000 }, () => {});
      // Native Node.js addons: also need execute bit to be dlopen()'d
      execFile('find', [dir, '-name', '*.node', '-exec', 'chmod', 'a+x', '{}', '+'],
        { timeout: 10000 }, () => {});
    } catch { /* best-effort */ }
  }
}

function claudeCmd(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    // Include the system npm global lib in NODE_PATH so plugin build steps can
    // find packages like @anthropic-ai/claude-code that are installed at the
    // system npm prefix (e.g. /usr/local/lib/node_modules).
    // NOTE: npm_config_prefix is intentionally NOT set here. Setting a custom
    // prefix causes `npm run build` to fail (exit code 2) during plugin install
    // because npm rewrites the PATH for lifecycle scripts to use the custom
    // prefix's bin dir, making globally-installed build tools (tsc, etc.)
    // invisible, and changes global node_modules resolution so peer dependencies
    // at the system prefix are not found. Plugin persistence is handled via HOME
    // (HOME/.claude symlinks to /etc/claude which is the mounted volume).
    const sysNpmGlobal = '/usr/local/lib/node_modules';
    const nodePath = process.env.NODE_PATH
      ? `${sysNpmGlobal}:${process.env.NODE_PATH}`
      : sysNpmGlobal;
    execFile(CLAUDE_BIN, args, {
      env: {
        ...process.env,
        HOME: CLAUDE_GLOBAL_HOME,
        npm_config_cache: '/etc/claude/npm-cache',
        NODE_PATH: nodePath,
      },
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim()));
      resolve(stdout);
    });
  });
}

app.get(GW + '/api/admin/plugins', requireAdmin, async (req, res) => {
  let installed = [];
  let available = [];
  try {
    const out = await claudeCmd(['plugin', 'list', '--json']);
    const data = JSON.parse(out || '[]');
    // claude plugin list --json returns an array of objects with fields:
    //   { id, version, scope, enabled, installPath, installedAt, ... }
    // where id is "plugin-name@marketplace". Normalise to a consistent shape.
    const arr = Array.isArray(data) ? data : (data.installed || data.plugins || []);
    for (const p of arr) {
      const id = p.id || p.plugin || p.name || '';
      const name = p.name || id.split('@')[0] || id;
      // Try to read description from installPath/package.json
      let description = p.description || '';
      if (!description && p.installPath) {
        for (const fname of ['package.json', 'manifest.json']) {
          try {
            const mf = JSON.parse(fs.readFileSync(path.join(p.installPath, fname), 'utf8'));
            description = mf.description || '';
            if (description) break;
          } catch {}
        }
      }
      installed.push({
        plugin: id,
        name,
        version: p.version && p.version !== 'unknown' ? p.version : undefined,
        description,
        isEnabled: p.enabled !== false,
        scope: p.scope,
        pendingEnable: p.pendingEnable,
        pendingToggle: p.pendingToggle,
        pendingUpdate: p.pendingUpdate,
      });
    }
    available = Array.isArray(data) ? [] : (data.available || []);
  } catch {
    // Fallback: read /etc/claude/plugins/ directory directly
    const pluginsDir = '/etc/claude/plugins';
    try {
      const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
      for (const entry of entries.filter(e => e.isDirectory())) {
        let manifest = {};
        for (const fname of ['package.json', 'manifest.json']) {
          try {
            manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, entry.name, fname), 'utf8'));
            break;
          } catch {}
        }
        installed.push({
          plugin: manifest.name || entry.name,
          name: manifest.name || entry.name,
          version: manifest.version,
          description: manifest.description,
          isEnabled: true,
        });
      }
    } catch {}
  }
  res.json({ installed, available });
});

app.post(GW + '/api/admin/plugins/install', requireAdmin, async (req, res) => {
  const { plugin } = req.body;
  if (!plugin || typeof plugin !== 'string' || !/^[a-zA-Z0-9@._/-]+$/.test(plugin))
    return res.status(400).json({ error: 'Invalid plugin name' });
  try {
    const out = await claudeCmd(['plugin', 'install', plugin, '--scope', 'user'], 180000);
    fixPluginPermissions();
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(GW + '/api/admin/plugins/uninstall', requireAdmin, async (req, res) => {
  const { plugin } = req.body;
  if (!plugin || typeof plugin !== 'string' || !/^[a-zA-Z0-9@._/-]+$/.test(plugin))
    return res.status(400).json({ error: 'Invalid plugin name' });
  try {
    const out = await claudeCmd(['plugin', 'uninstall', plugin]);
    fixPluginPermissions();
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(GW + '/api/admin/plugins/enable', requireAdmin, async (req, res) => {
  const { plugin } = req.body;
  if (!plugin || typeof plugin !== 'string' || !/^[a-zA-Z0-9@._/-]+$/.test(plugin))
    return res.status(400).json({ error: 'Invalid plugin name' });
  try {
    const out = await claudeCmd(['plugin', 'enable', plugin]);
    fixPluginPermissions();
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(GW + '/api/admin/plugins/disable', requireAdmin, async (req, res) => {
  const { plugin } = req.body;
  if (!plugin || typeof plugin !== 'string' || !/^[a-zA-Z0-9@._/-]+$/.test(plugin))
    return res.status(400).json({ error: 'Invalid plugin name' });
  try {
    const out = await claudeCmd(['plugin', 'disable', plugin]);
    fixPluginPermissions();
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Marketplace API ───────────────────────────────────────────────────────────

app.get(GW + '/api/admin/marketplaces', requireAdmin, async (req, res) => {
  let marketplaces = [];
  try {
    const out = await claudeCmd(['plugin', 'marketplace', 'list', '--json']);
    const data = JSON.parse(out || '[]');
    marketplaces = Array.isArray(data) ? data : (data.marketplaces || []);
  } catch {}
  // Also include extraKnownMarketplaces from settings.json so that
  // claude-plugins-official (registered at startup) is always visible.
  const settings = readSettings();
  const extra = settings.extraKnownMarketplaces || {};
  for (const [name, cfg] of Object.entries(extra)) {
    if (!marketplaces.find(m => (m.name || m.id) === name)) {
      marketplaces.push({ name, ...cfg });
    }
  }
  res.json(marketplaces);
});

app.post(GW + '/api/admin/marketplaces', requireAdmin, async (req, res) => {
  const { source } = req.body;
  if (!source || typeof source !== 'string') return res.status(400).json({ error: 'source required' });
  try {
    const out = await claudeCmd(['plugin', 'marketplace', 'add', source, '--scope', 'user'], 180000);
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete(GW + '/api/admin/marketplaces/:name', requireAdmin, async (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    const out = await claudeCmd(['plugin', 'marketplace', 'remove', name]);
    res.json({ ok: true, output: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Global .mcp.json sync ─────────────────────────────────────────────────────
// Claude Code reads MCP server definitions from .mcp.json files found by walking
// up the directory tree from the active project.  Settings.json is NOT used for
// MCP server definitions (only for approval/deny lists).  We maintain a shared
// /data/.mcp.json that sits above all user workspaces so every user's project
// walk reaches it.

const GLOBAL_MCP_PATH = '/data/.mcp.json';

function syncMcpJson() {
  try {
    const settings = readSettings();
    const servers = settings.mcpServers || {};
    // Filter out disabled servers and strip the 'disabled' flag before writing
    const active = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg.disabled) {
        const { disabled, ...serverCfg } = cfg; // eslint-disable-line no-unused-vars
        active[name] = serverCfg;
      }
    }
    if (Object.keys(active).length > 0) {
      fs.writeFileSync(
        GLOBAL_MCP_PATH,
        JSON.stringify({ mcpServers: active }, null, 2) + '\n',
        { mode: 0o644 }
      );
    } else {
      // No active servers — remove the file so Claude Code sees no servers
      if (fs.existsSync(GLOBAL_MCP_PATH)) fs.unlinkSync(GLOBAL_MCP_PATH);
    }
  } catch (e) {
    console.warn('[gateway] Failed to sync .mcp.json:', e.message);
  }
}

// ── MCP servers (plugins) API ─────────────────────────────────────────────────

const MCP_NAME_RE = /^[a-zA-Z0-9_-]+$/;

app.get(GW + '/api/admin/mcp', requireAdmin, (req, res) => {
  const settings = readSettings();
  const servers = settings.mcpServers || {};
  res.json(Object.entries(servers).map(([name, cfg]) => ({ name, ...cfg })));
});

app.put(GW + '/api/admin/mcp/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!MCP_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  const { type, command, args, env, url, headers, disabled } = req.body;
  let cfg;
  if (type === 'sse') {
    if (!url) return res.status(400).json({ error: 'URL required for SSE server' });
    cfg = { type: 'sse', url };
    if (headers && Object.keys(headers).length) cfg.headers = headers;
  } else {
    if (!command) return res.status(400).json({ error: 'Command required' });
    cfg = { command };
    if (Array.isArray(args) && args.length) cfg.args = args;
    if (env && Object.keys(env).length) cfg.env = env;
  }
  if (disabled) cfg.disabled = true;
  const settings = readSettings();
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers[name] = cfg;
  writeSettings(settings);
  syncMcpJson();
  res.json({ ok: true });
});

app.delete(GW + '/api/admin/mcp/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (!MCP_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid name' });
  const settings = readSettings();
  if (!settings.mcpServers || !settings.mcpServers[name])
    return res.status(404).json({ error: 'Not found' });
  delete settings.mcpServers[name];
  writeSettings(settings);
  syncMcpJson();
  res.json({ ok: true });
});

// ── Notifications API ─────────────────────────────────────────────────────────

const NOTIFICATIONS_PATH = '/var/lib/multiuser-ccui/notifications.json';

function readNotifications() {
  try { return JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8')); } catch { return []; }
}

function writeNotifications(arr) {
  fs.mkdirSync(path.dirname(NOTIFICATIONS_PATH), { recursive: true });
  fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(arr, null, 2) + '\n', { mode: 0o644 });
}

// Public: all authenticated users can read active notifications
app.get(GW + '/api/notifications', requireAuth, (req, res) => {
  const all = readNotifications();
  res.json(all.filter(n => n.active));
});

// Admin: full CRUD
app.get(GW + '/api/admin/notifications', requireAdmin, (req, res) => {
  res.json(readNotifications());
});

app.post(GW + '/api/admin/notifications', requireAdmin, (req, res) => {
  const { title, message, type, active } = req.body;
  if (!title || typeof title !== 'string' || !title.trim())
    return res.status(400).json({ error: 'title required' });
  const notifications = readNotifications();
  const id = Date.now();
  const notif = {
    id,
    title: title.trim(),
    message: typeof message === 'string' ? message.trim() : '',
    type: ['info', 'warning', 'error'].includes(type) ? type : 'info',
    active: active !== false,
    createdAt: new Date().toISOString(),
  };
  notifications.push(notif);
  writeNotifications(notifications);
  res.json(notif);
});

app.put(GW + '/api/admin/notifications/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notifications = readNotifications();
  const idx = notifications.findIndex(n => n.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { title, message, type, active } = req.body;
  if (title !== undefined) notifications[idx].title = String(title).trim();
  if (message !== undefined) notifications[idx].message = String(message).trim();
  if (type !== undefined && ['info', 'warning', 'error'].includes(type)) notifications[idx].type = type;
  if (active !== undefined) notifications[idx].active = !!active;
  writeNotifications(notifications);
  res.json(notifications[idx]);
});

app.delete(GW + '/api/admin/notifications/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const notifications = readNotifications();
  const idx = notifications.findIndex(n => n.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  notifications.splice(idx, 1);
  writeNotifications(notifications);
  res.json({ ok: true });
});

// ── User git settings ─────────────────────────────────────────────────────────

/**
 * Regenerate /data/users/{username}/.gitconfig from stored settings.
 * Called on settings save and during new-user setup.
 */
function applyUserGitConfig(username, settings) {
  const home = `/data/users/${username}`;
  const gitconfigPath = path.join(home, '.gitconfig');

  const git = settings.git || {};
  const name = (git.name || '').trim() || username;
  const email = (git.email || '').trim() || `${username}@localhost`;

  let content = `[user]\n\tname = ${name}\n\temail = ${email}\n`;

  // Per-GitLab token entries via url.insteadOf
  const gitlabs = Array.isArray(settings.gitlabs) ? settings.gitlabs : [];
  for (const entry of gitlabs) {
    const rawUrl = (entry.url || '').trim().replace(/\/$/, '');
    const token = (entry.token || '').trim();
    if (!rawUrl || !token) continue;
    const authedUrl = rawUrl.replace(/^(https?:\/\/)/, `$1oauth2:${token}@`);
    content += `[url "${authedUrl}/"]\n\tinsteadOf = ${rawUrl}/\n`;
  }

  // Generic URL redirects via url.insteadOf
  // Normalise HTTP/HTTPS base URLs to always have a trailing slash so that
  // git's prefix-replacement logic produces a valid URL.  Without the slash,
  // "insteadOf = https://host" applied to "https://host/path" would yield
  // "<base>/path" (correct) but "insteadOf = https://host/" applied to the
  // same URL with a base lacking the slash would yield "<base>path" (broken).
  // Keeping both sides consistent avoids double-slashes or missing slashes.
  const redirects = Array.isArray(settings.urlRedirects) ? settings.urlRedirects : [];
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

  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(gitconfigPath, content, { mode: 0o644 });
    const dbUser = db.findByUsername(username);
    if (dbUser) {
      try { fs.chownSync(gitconfigPath, dbUser.uid, dbUser.uid); } catch {}
    }
  } catch (e) {
    console.warn(`[gw] gitconfig write warning for ${username}:`, e.message);
  }
}

app.get(GW + '/api/user/settings', requireAuth, (req, res) => {
  const settings = db.getUserSettings(req.user.id);
  res.json(settings);
});

app.put(GW + '/api/user/settings', requireAuth, (req, res) => {
  const { git, gitlabs, urlRedirects } = req.body;

  if (git !== undefined && typeof git !== 'object') return res.status(400).json({ error: 'Invalid git field' });
  if (gitlabs !== undefined && !Array.isArray(gitlabs)) return res.status(400).json({ error: 'Invalid gitlabs field' });
  if (urlRedirects !== undefined && !Array.isArray(urlRedirects)) return res.status(400).json({ error: 'Invalid urlRedirects field' });

  const settings = {
    git: {
      name: String((git && git.name) || '').trim(),
      email: String((git && git.email) || '').trim(),
    },
    gitlabs: (gitlabs || []).map(g => ({
      url: String(g.url || '').trim(),
      token: String(g.token || '').trim(),
    })).filter(g => g.url),
    urlRedirects: (urlRedirects || []).map(r => ({
      from: String(r.from || '').trim(),
      to: String(r.to || '').trim(),
    })).filter(r => r.from && r.to),
  };

  db.updateUserSettings(req.user.id, settings);
  applyUserGitConfig(req.user.username, settings);
  res.json({ ok: true });
});

// ── Current-user API ──────────────────────────────────────────────────────────

app.get(GW + '/api/me', (req, res) => {
  const user = verifyToken(tokenFromReq(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ username: user.username, role: user.role });
});

// ── Proxy to user's claudecodeui ──────────────────────────────────────────────

const LOGOUT_SCRIPT_TAG = '<script src="/__gateway/static/logout-bar.js"></script>';

const proxy = httpProxy.createProxyServer({ xfwd: true, selfHandleResponse: true });
proxy.on('error', (err, req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Session unavailable. Please reload the page.');
  }
});

proxy.on('proxyReq', (proxyReq) => {
  // Ask upstream for uncompressed responses so we can inject into HTML
  proxyReq.setHeader('accept-encoding', 'identity');
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const contentType = proxyRes.headers['content-type'] || '';
  const isHtml = contentType.includes('text/html');
  const isJs   = contentType.includes('application/javascript') ||
                 contentType.includes('text/javascript');

  if (!isHtml && !isJs) {
    // Non-text: pipe through unchanged
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  // Buffer text response for logout-bar injection and esm.sh URL rewriting
  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    let text = Buffer.concat(chunks).toString('utf8');

    if (isHtml) {
      if (text.includes('</body>')) {
        text = text.replace('</body>', LOGOUT_SCRIPT_TAG + '</body>');
      } else {
        text += LOGOUT_SCRIPT_TAG;
      }
    }

    // Rewrite esm.sh CDN imports to locally-bundled copies so the terminal
    // plugin works without internet access (see /__esm/ route and Dockerfile).
    if (text.includes('https://esm.sh/')) {
      text = text.replace(/https:\/\/esm\.sh\//g, '/__esm/');
    }

    const headers = Object.assign({}, proxyRes.headers);
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(text);

    res.writeHead(proxyRes.statusCode, headers);
    res.end(text);
  });
});

app.use(async (req, res) => {
  const user = verifyToken(tokenFromReq(req));
  if (!user) return res.redirect(GW + '/login');

  // Re-read from DB to catch block/delete that happened after token was issued
  const dbUser = db.getUserById(user.id);
  if (!dbUser || dbUser.blocked) {
    res.clearCookie('token');
    return res.redirect(GW + '/login?error=blocked');
  }

  try {
    const port = await pm.getOrStart(user.username, user.role === 'admin' ? 0 : user.uid);
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  } catch (err) {
    console.error(`[gw] proxy error for ${user.username}:`, err.message);
    res.status(502).send(`<pre>Could not start session:\n${err.message}\n\nCheck server logs.</pre>`);
  }
});

// ── HTTP server + WebSocket proxy ─────────────────────────────────────────────

const server = http.createServer(app);

server.on('upgrade', async (req, socket, head) => {
  // Parse cookie header
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), v.join('=')];
    })
  );

  // claudecodeui may pass token as query param for WS connections
  let tokenStr = cookies.token;
  if (!tokenStr) {
    try {
      const url = new URL(req.url, 'http://localhost');
      tokenStr = url.searchParams.get('token') || '';
    } catch {}
  }

  const user = verifyToken(tokenStr);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Re-read from DB to catch block/delete that happened after token was issued
  const dbUser = db.getUserById(user.id);
  if (!dbUser || dbUser.blocked) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const port = await pm.getOrStart(user.username, user.role === 'admin' ? 0 : user.uid);
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${port}` });
  } catch (err) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

// ── Initialise ────────────────────────────────────────────────────────────────

db.init();

// Bootstrap admin account
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';
if (!db.findByUsername('admin')) {
  const uid = db.nextUid();
  db.createUser('admin', bcrypt.hashSync(ADMIN_PASS, 10), 'admin', uid);
  pm.setupUserDir('admin', 0);
  console.log(`[gw] Admin account created (password: ${ADMIN_PASS})`);
}

server.listen(4000, '0.0.0.0', () => {
  console.log('[gw] Gateway listening on port 4000');
});
