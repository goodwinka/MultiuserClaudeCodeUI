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
RUN apt-get update && apt-get install -y \
    curl wget git sudo procps unzip \
    gcc g++ clang clangd cmake make build-essential \
    python3 python3-pip python3-venv \
    sqlite3 nginx \
    default-jre-headless \
    qtbase5-dev qt5-qmake qttools5-dev-tools \
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

# ── npm-based language servers ─────────────────────────────────────────────────
RUN npm install -g \
    pyright \
    bash-language-server \
    vscode-langservers-extracted

# ── pip-based language servers ─────────────────────────────────────────────────
RUN pip install --break-system-packages \
    python-lsp-server \
    cmake-language-server

# ── Kotlin language server ─────────────────────────────────────────────────────
ARG KOTLIN_LS_VERSION=1.3.11
RUN curl -fsSL \
      "https://github.com/fwcd/kotlin-language-server/releases/download/${KOTLIN_LS_VERSION}/server.zip" \
      -o /tmp/kotlin-ls.zip \
    && unzip /tmp/kotlin-ls.zip -d /opt/kotlin-language-server \
    && ln -s /opt/kotlin-language-server/server/bin/kotlin-language-server \
             /usr/local/bin/kotlin-language-server \
    && rm /tmp/kotlin-ls.zip

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
