FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl wget git sudo procps \
    gcc g++ clang clangd cmake make build-essential \
    python3 python3-pip python3-venv \
    sqlite3 nginx \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 ─────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Claude Code CLI ────────────────────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

# ── ClaudeCodeUI ───────────────────────────────────────────────────────────────
WORKDIR /opt/claudecodeui
RUN git clone https://github.com/siteboon/claudecodeui.git . \
    && npm install \
    && npm run build

# ── Gateway dependencies ───────────────────────────────────────────────────────
WORKDIR /opt/gateway
COPY gateway/package.json ./
RUN npm install --production

COPY gateway/ ./

# ── Nginx ──────────────────────────────────────────────────────────────────────
COPY nginx/nginx.conf /etc/nginx/sites-available/default
RUN rm -f /etc/nginx/sites-enabled/default \
    && ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default

# ── Scripts ────────────────────────────────────────────────────────────────────
COPY scripts/ /opt/scripts/
RUN chmod +x /opt/scripts/*.sh

# ── Claude global config ───────────────────────────────────────────────────────
RUN mkdir -p /etc/claude
COPY claude-config/settings.json /etc/claude/settings.json
RUN chmod 644 /etc/claude/settings.json

# ── Runtime directories ────────────────────────────────────────────────────────
RUN mkdir -p /data/users /var/lib/multiuser-ccui/logs

EXPOSE 80

ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
