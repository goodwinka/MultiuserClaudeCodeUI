FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ── Build-time proxy support ───────────────────────────────────────────────────
# These ARGs make proxy env vars available during RUN commands when passed with
# --build-arg. In production builds without a proxy they are simply empty.
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG http_proxy=""
ARG https_proxy=""
ARG NO_PROXY=""
ARG no_proxy=""
# Optional PEM-encoded CA certificate to trust (e.g. for TLS-intercepting proxies)
# ── System packages ────────────────────────────────────────────────────────────
# Language servers (clangd, pyright, pylsp, bash-language-server,
# cmake-language-server, vscode-css/html/json, kotlin-language-server)
# and Qt5 are NOT installed in the image — they are supplied at runtime
# by bind-mounting host paths (see docker-compose.yml).
# Only the minimal runtime libraries that those tools depend on are included.
RUN apt-get update && apt-get install -y \
    curl wget git sudo procps unzip \
    gcc g++ clang cmake make build-essential \
    python3 python3-pip python3-venv \
    sqlite3 nginx \
    default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# ── Optional extra CA cert (for TLS-intercepting proxies) ─────────────────────
ARG EXTRA_CA_CERT=""
RUN if [ -n "$EXTRA_CA_CERT" ]; then \
      printf '%s\n' "$EXTRA_CA_CERT" >> /etc/ssl/certs/ca-certificates.crt \
      && printf '%s\n' "$EXTRA_CA_CERT" > /etc/ssl/certs/extra-ca.pem; \
    fi
# Node.js reads this env var to trust extra CAs (used by npm, node, git, etc.)
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

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
    && VITE_IS_PLATFORM=true npm run build

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
# Store the default outside volume-mounted paths so entrypoint can seed it
RUN mkdir -p /opt/defaults/claude
COPY claude-config/settings.json /opt/defaults/claude/settings.json
RUN chmod 644 /opt/defaults/claude/settings.json

# ── Runtime directories ────────────────────────────────────────────────────────
# These are created here for non-volume runs; entrypoint re-creates them
# (volume mounts shadow image content, so entrypoint handles seeding)
RUN mkdir -p /data/users /var/lib/multiuser-ccui/logs /etc/claude

EXPOSE 80

ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
