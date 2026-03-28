#!/bin/bash
set -e

echo "==> Starting MultiUser ClaudeCodeUI"

# ── Host-installed tools (language servers, Qt5, …) ───────────────────────────
# When /opt/host/usr/bin is bind-mounted from the host (see docker-compose.yml)
# prepend the host paths to PATH and LD_LIBRARY_PATH so that clangd, pyright,
# pylsp, bash-language-server, cmake-language-server, vscode-*-language-server,
# kotlin-language-server, qmake, etc. are found inside the container.
if [ -d /opt/host/usr/local/bin ]; then
  export PATH="/opt/host/usr/local/bin:/opt/host/usr/bin:${PATH}"
fi
if [ -d /opt/host/usr/lib ]; then
  export LD_LIBRARY_PATH="/opt/host/usr/lib:/opt/host/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi
# Qt5 pkg-config / cmake find_package support
if [ -d /opt/host/usr/lib/x86_64-linux-gnu/pkgconfig ]; then
  export PKG_CONFIG_PATH="/opt/host/usr/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}"
fi
if [ -d /opt/host/usr/lib/x86_64-linux-gnu/cmake ]; then
  export CMAKE_PREFIX_PATH="/opt/host/usr/lib/x86_64-linux-gnu/cmake:${CMAKE_PREFIX_PATH:-}"
fi
# CUDA Toolkit (nvcc, headers, libcuda, libcudart …)
if [ -d /opt/host/usr/local/cuda ]; then
  export CUDA_HOME=/opt/host/usr/local/cuda
  export PATH="${CUDA_HOME}/bin:${PATH}"
  export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${CUDA_HOME}/lib64/stubs:${LD_LIBRARY_PATH:-}"
fi

# ── Ensure data directories exist ─────────────────────────────────────────────
mkdir -p /data/users /var/lib/multiuser-ccui/logs \
         /etc/claude /etc/claude/agents /etc/claude/plugins \
         /etc/claude/npm-global /etc/claude/npm-cache

# Seed default Claude settings if the volume was mounted empty
if [ ! -f /etc/claude/settings.json ]; then
  cp /opt/defaults/claude/settings.json /etc/claude/settings.json
  chmod 644 /etc/claude/settings.json
fi

# Ensure shared directories are world-readable/executable
chmod 755 /etc/claude/agents /etc/claude/plugins

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
