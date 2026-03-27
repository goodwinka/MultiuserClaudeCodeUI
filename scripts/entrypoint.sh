#!/bin/bash
set -e

echo "==> Starting MultiUser ClaudeCodeUI"

# ── Ensure data directories exist ─────────────────────────────────────────────
mkdir -p /data/users /var/lib/multiuser-ccui/logs

# ── Nginx ──────────────────────────────────────────────────────────────────────
echo "==> Starting nginx"
nginx -t
service nginx start

# ── Gateway ───────────────────────────────────────────────────────────────────
echo "==> Starting gateway"
exec node /opt/gateway/index.js
