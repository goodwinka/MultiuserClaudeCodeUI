#!/bin/bash
set -e

echo "==> Starting MultiUser ClaudeCodeUI"

# ── Ensure data directories exist ─────────────────────────────────────────────
mkdir -p /data/users /var/lib/multiuser-ccui/logs /etc/claude

# Seed default Claude settings if the volume was mounted empty
if [ ! -f /etc/claude/settings.json ]; then
  cp /opt/defaults/claude/settings.json /etc/claude/settings.json
  chmod 644 /etc/claude/settings.json
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
