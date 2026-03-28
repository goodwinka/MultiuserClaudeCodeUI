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
  res.json({ ok: true });
});

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

  if (!contentType.includes('text/html')) {
    // Non-HTML: pipe through unchanged
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  // Buffer HTML response and inject logout bar script
  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    let html = Buffer.concat(chunks).toString('utf8');

    if (html.includes('</body>')) {
      html = html.replace('</body>', LOGOUT_SCRIPT_TAG + '</body>');
    } else {
      html += LOGOUT_SCRIPT_TAG;
    }

    const headers = Object.assign({}, proxyRes.headers);
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    headers['content-length'] = Buffer.byteLength(html);

    res.writeHead(proxyRes.statusCode, headers);
    res.end(html);
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
    const port = await pm.getOrStart(user.username, user.uid);
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
    const port = await pm.getOrStart(user.username, user.uid);
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
  pm.setupUserDir('admin', uid);
  console.log(`[gw] Admin account created (password: ${ADMIN_PASS})`);
}

server.listen(4000, '0.0.0.0', () => {
  console.log('[gw] Gateway listening on port 4000');
});
