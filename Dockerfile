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
    # ── Testing tools: C / C++ ─────────────────────────────────────────────────
    libgtest-dev libgmock-dev \
    libcppunit-dev \
    check \
    valgrind \
    lcov gcovr \
    # ── Testing tools: Qt ──────────────────────────────────────────────────────
    libqt5test5 \
    # ── Testing tools: Python ──────────────────────────────────────────────────
    python3-pytest python3-coverage \
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
    vscode-langservers-extracted \
    typescript

# ── pip-based language servers ─────────────────────────────────────────────────
RUN pip install --break-system-packages \
    python-lsp-server \
    cmake-language-server

# ── pip-based testing tools ────────────────────────────────────────────────────
RUN pip install --break-system-packages \
    pytest \
    pytest-cov \
    pytest-xdist \
    coverage \
    unittest-xml-reporting

# ── Build Google Test shared libraries ────────────────────────────────────────
RUN cd /usr/src/googletest \
    && cmake . -DBUILD_SHARED_LIBS=ON \
    && make -j$(nproc) \
    && make install \
    && ldconfig

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
COPY patches/ /opt/patches/
RUN git clone https://github.com/siteboon/claudecodeui.git . \
    && cp /opt/patches/chat/ProviderSelectionEmptyState.tsx \
          src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx \
    && cp /opt/patches/server/utils/plugin-process-manager.js \
          server/utils/plugin-process-manager.js \
    && npm install \
    && VITE_IS_PLATFORM=true npm run build

# ── xterm ESM bundles (offline CDN replacement for esm.sh) ───────────────────
# Pre-bundle xterm packages so the terminal plugin works without internet access.
# The gateway rewrites https://esm.sh/ → /__esm/ in proxied JS/HTML responses,
# and serves these files at that path.
RUN mkdir -p /tmp/xterm-build \
    && cd /tmp/xterm-build \
    && npm init -y \
    && npm install --save-exact \
         @xterm/xterm@5.5.0 \
         @xterm/addon-fit@0.10.0 \
         @xterm/addon-web-links@0.11.0 \
         @xterm/addon-search@0.15.0 \
         @xterm/addon-webgl@0.18.0 \
         @xterm/addon-clipboard@0.1.0 \
         @xterm/addon-unicode11@0.8.0 \
    && npm install --save-dev esbuild \
    && mkdir -p /opt/esm-bundles/@xterm \
    && printf 'export * from "@xterm/xterm";\n'           > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/xterm@5.5.0 \
    && printf 'export * from "@xterm/addon-fit";\n'       > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/addon-fit@0.10.0 \
    && printf 'export * from "@xterm/addon-web-links";\n'  > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/addon-web-links@0.11.0 \
    && printf 'export * from "@xterm/addon-search";\n'    > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/addon-search@0.15.0 \
    && printf 'export * from "@xterm/addon-webgl";\n'     > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/addon-webgl@0.18.0 \
    && printf 'export * from "@xterm/addon-clipboard";\n' > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/addon-clipboard@0.1.0 \
    && printf 'export * from "@xterm/addon-unicode11";\n'  > entry.mjs \
    && ./node_modules/.bin/esbuild entry.mjs --bundle --format=esm \
         --outfile=/opt/esm-bundles/@xterm/addon-unicode11@0.8.0 \
    && cd / && rm -rf /tmp/xterm-build

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
COPY claude-config/CLAUDE.md     /opt/defaults/claude/CLAUDE.md
RUN chmod 644 /opt/defaults/claude/settings.json /opt/defaults/claude/CLAUDE.md

# ── Runtime directories ────────────────────────────────────────────────────────
# These are created here for non-volume runs; entrypoint re-creates them
# (volume mounts shadow image content, so entrypoint handles seeding)
RUN mkdir -p /data/users /var/lib/multiuser-ccui/logs /etc/claude

EXPOSE 80

ENTRYPOINT ["/opt/scripts/entrypoint.sh"]
