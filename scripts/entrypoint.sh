#!/bin/bash
set -e

echo "==> Starting MultiUser ClaudeCodeUI"

# ── CUDA Toolkit (host-mounted at /usr/local/cuda) ────────────────────────────
# All other tools (language servers, Qt5) are installed in the image.
# CUDA is the only host mount because its size makes it impractical to bake in.
if [ -d /usr/local/cuda ]; then
  export CUDA_HOME=/usr/local/cuda
  export PATH="${PATH}:/usr/local/cuda/bin"
  export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:/usr/local/cuda/lib64:/usr/local/cuda/lib64/stubs"
fi

# ── Ensure data directories exist ─────────────────────────────────────────────
mkdir -p /data/users /var/lib/multiuser-ccui/logs \
         /etc/claude /etc/claude/agents /etc/claude/skills /etc/claude/plugins \
         /etc/claude/npm-global /etc/claude/npm-cache \
         /etc/claude-code-ui/plugins

# Seed default Claude settings if the volume was mounted empty
if [ ! -f /etc/claude/settings.json ]; then
  cp /opt/defaults/claude/settings.json /etc/claude/settings.json
  chmod 644 /etc/claude/settings.json
fi

# Seed default CLAUDE.md if the volume was mounted empty
if [ ! -f /etc/claude/CLAUDE.md ]; then
  cp /opt/defaults/claude/CLAUDE.md /etc/claude/CLAUDE.md
  chmod 644 /etc/claude/CLAUDE.md
fi

# Ensure the official plugin marketplace is registered (idempotent, covers upgrades)
node -e "
const fs = require('fs');
const f = '/etc/claude/settings.json';
try {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  let dirty = false;
  if (!s.extraKnownMarketplaces) s.extraKnownMarketplaces = {};
  if (!s.extraKnownMarketplaces['claude-plugins-official']) {
    s.extraKnownMarketplaces['claude-plugins-official'] = {
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' }
    };
    dirty = true;
    console.log('Registered claude-plugins-official marketplace in settings');
  }
  // Claude Code reads MCP server definitions from .mcp.json files, not from
  // settings.json.  enableAllProjectMcpServers auto-approves the shared
  // /data/.mcp.json that the gateway maintains for admin-configured servers.
  if (s.enableAllProjectMcpServers === undefined) {
    s.enableAllProjectMcpServers = true;
    dirty = true;
    console.log('Set enableAllProjectMcpServers=true in settings');
  }
  if (dirty) fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
} catch(e) { console.error('Warning: could not patch settings.json:', e.message); }
" 2>&1 || true

# Sync /data/.mcp.json from any MCP servers already stored in settings.json
# (covers the case where the volume is re-mounted after an upgrade)
node -e "
const fs = require('fs');
const f = '/etc/claude/settings.json';
const out = '/data/.mcp.json';
try {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  const servers = s.mcpServers || {};
  const active = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.disabled) {
      const { disabled, ...rest } = cfg;
      active[name] = rest;
    }
  }
  if (Object.keys(active).length > 0) {
    fs.writeFileSync(out, JSON.stringify({ mcpServers: active }, null, 2) + '\n', { mode: 0o644 });
    console.log('Synced', Object.keys(active).length, 'MCP server(s) to', out);
  } else if (fs.existsSync(out)) {
    fs.unlinkSync(out);
    console.log('Removed empty', out);
  }
} catch(e) { console.error('Warning: could not sync .mcp.json:', e.message); }
" 2>&1 || true

# Ensure volume-mounted config roots and their contents are world-readable.
# /etc/claude and /etc/claude-code-ui are bind-mounted from the host; the host
# directory may have been created by root with restrictive permissions (e.g. 700),
# which would prevent non-root ClaudeCodeUI processes (uid 10000+) from reading
# settings.json or traversing subdirectories.  Fix unconditionally on every start.
chmod 755 /etc/claude /etc/claude-code-ui
chmod 644 /etc/claude/settings.json /etc/claude/CLAUDE.md 2>/dev/null || true
chmod 755 /etc/claude/agents /etc/claude/skills /etc/claude/plugins
chmod 755 /etc/claude-code-ui/plugins

# Make all installed plugin files accessible to non-root ClaudeCodeUI processes
# (uid 10000+).  Plugins are installed as root via the admin panel; without this
# step non-root processes can't read JS assets or load native .node addons, which
# causes the terminal plugin backend to fail and the shell tab to show no settings.
find /etc/claude/plugins /etc/claude/npm-global /etc/claude-code-ui/plugins \
    -type f -exec chmod a+r  {} + 2>/dev/null || true
find /etc/claude/plugins /etc/claude/npm-global /etc/claude-code-ui/plugins \
    -type d -exec chmod a+rx {} + 2>/dev/null || true
# Native Node.js addons (.node) must also be executable
find /etc/claude/plugins /etc/claude/npm-global /etc/claude-code-ui/plugins \
    -name "*.node" -exec chmod a+x {} + 2>/dev/null || true

# Set up a global "home" for managing plugins as root.
# claude plugin install uses HOME/.claude as the config dir, so by symlinking
# /var/lib/claude-global/.claude → /etc/claude, any plugin install goes straight
# into /etc/claude/plugins/ which is shared with all users.
mkdir -p /var/lib/claude-global
if [ ! -e /var/lib/claude-global/.claude ]; then
  ln -s /etc/claude /var/lib/claude-global/.claude
fi

# ── Git system-wide configuration ─────────────────────────────────────────────
echo "==> Configuring git"
# Safe directory: allow git in all /data/users subdirectories
git config --system safe.directory '*'
# Default identity for commits (users can override in their own .gitconfig)
git config --system user.email "user@localhost"
git config --system user.name "Claude Code User"
# Proxy for remote git operations (optional, driven by GIT_PROXY_URL env var)
if [ -n "${GIT_PROXY_URL}" ]; then
  echo "==> Configuring git proxy: ${GIT_PROXY_URL}"
  git config --system http.proxy "${GIT_PROXY_URL}"
  git config --system https.proxy "${GIT_PROXY_URL}"
elif [ -n "${HTTP_PROXY}" ]; then
  echo "==> Configuring git proxy from HTTP_PROXY: ${HTTP_PROXY}"
  git config --system http.proxy "${HTTP_PROXY}"
  git config --system https.proxy "${HTTPS_PROXY:-${HTTP_PROXY}}"
fi
# Disable SSL verification if GIT_SSL_NO_VERIFY is set to a truthy value
if [ "${GIT_SSL_NO_VERIFY}" = "true" ] || [ "${GIT_SSL_NO_VERIFY}" = "1" ]; then
  echo "==> Disabling git SSL verification (GIT_SSL_NO_VERIFY=${GIT_SSL_NO_VERIFY})"
  git config --system http.sslVerify false
fi

# ── Nginx ──────────────────────────────────────────────────────────────────────
echo "==> Starting nginx"
nginx -t
service nginx start

# ── Gateway ───────────────────────────────────────────────────────────────────
echo "==> Starting gateway"
exec node /opt/gateway/index.js
