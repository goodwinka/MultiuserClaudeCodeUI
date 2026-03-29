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
  if (!s.extraKnownMarketplaces) s.extraKnownMarketplaces = {};
  if (!s.extraKnownMarketplaces['claude-plugins-official']) {
    s.extraKnownMarketplaces['claude-plugins-official'] = {
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' }
    };
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
    console.log('Registered claude-plugins-official marketplace in settings');
  }
} catch(e) { console.error('Warning: could not patch settings.json:', e.message); }
" 2>&1 || true

# Ensure shared directories are world-readable/executable
chmod 755 /etc/claude/agents /etc/claude/skills /etc/claude/plugins
chmod 755 /etc/claude-code-ui/plugins

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

# ── Nginx ──────────────────────────────────────────────────────────────────────
echo "==> Starting nginx"
nginx -t
service nginx start

# ── Gateway ───────────────────────────────────────────────────────────────────
echo "==> Starting gateway"
exec node /opt/gateway/index.js
