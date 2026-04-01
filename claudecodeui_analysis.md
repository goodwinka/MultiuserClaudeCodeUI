# Анализ репозитория siteboon/claudecodeui

Источник: https://github.com/siteboon/claudecodeui  
Версия: @siteboon/claude-code-ui v1.27.1  
Лицензия: AGPL-3.0  
Дата анализа: 2026-04-01

---

## 1. Общая структура репозитория

```
.github/          CI/CD (GitHub Actions)
.husky/           Git hooks (lint-staged, commitlint)
plugins/          Система плагинов (git submodule: cloudcli-plugin-starter)
public/           Статические ресурсы
scripts/          Build/release скрипты
server/           Node.js бэкенд
shared/           Общие утилиты (фронтенд + бэкенд)
src/              React/TypeScript фронтенд
index.html        Точка входа Vite
vite.config.js    Конфиг Vite
tailwind.config.js
tsconfig.json
package.json
```

### Стек технологий

| Слой           | Технология |
|----------------|------------|
| Фронтенд       | React 18.2.0 + TypeScript, Vite |
| Стили          | Tailwind CSS |
| Терминал UI    | xterm.js (`@xterm/xterm`) + WebGL addon, FitAddon, WebLinksAddon |
| Бэкенд         | Node.js + Express.js |
| Real-time связь | `ws` (WebSocket) |
| PTY / shell    | `node-pty` (псевдотерминал) |
| База данных    | SQLite3 + `better-sqlite3` |
| AI SDK         | `@anthropic-ai/claude-code` ^0.2.59 |
| Состояние      | Zustand stores |

### Структура server/

```
server/
  index.js              Главный сервер (Express + WebSocket + PTY логика)
  cli.js                CLI точка входа (команды claude-code-ui / cloudcli)
  claude-sdk.js         Интеграция с Anthropic Agent SDK
  cursor-cli.js         Интеграция с Cursor AI
  gemini-cli.js         Интеграция с Gemini CLI
  openai-codex.js       Интеграция с OpenAI Codex
  sessionManager.js     Управление сессиями Gemini (SQLite + Map)
  projects.js           Сканирование файловой системы проектов
  routes/               16 файлов HTTP-маршрутов (agent, auth, git, mcp, plugins, ...)
  services/             notification-orchestrator.js, vapid-keys.js
  utils/
  database/
  middleware/
  providers/
```

---

## 2. Shell Tab — встроенная консоль Claude Code

### Описание

Shell Tab — это полноценный встроенный терминал на базе xterm.js, подключённый через WebSocket к `node-pty` псевдотерминалу на сервере. Запускает `claude` (или другие AI CLI) внутри PTY в директории проекта.

### Ключевые файлы фронтенда

| Файл | Роль |
|------|------|
| `src/components/shell/view/Shell.tsx` | Главный React-компонент: рендерит контейнер терминала, оверлеи, кнопки-опции промпта, панель шорткатов |
| `src/components/shell/hooks/useShellRuntime.ts` | Оркестрирующий хук: связывает terminal + connection хуки |
| `src/components/shell/hooks/useShellTerminal.ts` | Жизненный цикл xterm.js: создание/уничтожение Terminal, загрузка аддонов, клавиатура, ResizeObserver |
| `src/components/shell/hooks/useShellConnection.ts` | Жизненный цикл WebSocket: подключение к `/shell`, отправка `init`, получение `output`/`auth_url` |
| `src/components/shell/utils/socket.ts` | URL билдер + хелперы для отправки/парсинга сообщений |
| `src/components/shell/constants/constants.ts` | Настройки терминала (шрифт, цвета, scrollback=10000), таймауты |
| `src/components/shell/types/types.ts` | TypeScript-интерфейсы для сообщений и опций хуков |
| `src/components/standalone-shell/view/StandaloneShell.tsx` | Враппер для standalone/embedded использования |

### Как запускается (поток инициализации)

1. `Shell.tsx` рендерится с props: `selectedProject`, `selectedSession`, `initialCommand`, `isPlainShell`, `autoConnect`.
2. `useShellRuntime` → `useShellTerminal` инициализирует xterm.js `Terminal` и монтирует в `terminalContainerRef`. Загружаются аддоны: `FitAddon`, `WebLinksAddon`, `WebglAddon` (с fallback на Canvas).
3. `useShellConnection.connectToShell()` открывает WebSocket на `/shell?token=<jwt>` (или просто `/shell` в platform mode).
4. При `socket.onopen`, после задержки `TERMINAL_INIT_DELAY_MS` (100мс), клиент отправляет **`init` сообщение**:

```json
{
  "type": "init",
  "projectPath": "/absolute/path/to/project",
  "sessionId": "abc123",
  "hasSession": true,
  "provider": "claude",
  "cols": 220,
  "rows": 50,
  "initialCommand": null,
  "isPlainShell": false
}
```

### Как запускается на сервере (функция handleShellConnection)

Файл: **`server/index.js`**

1. Получает `init` сообщение.
2. Формирует команду в зависимости от `provider`:
   - **claude**: `claude --resume "<sessionId>" || claude`
   - **cursor**: `cursor-agent --resume="<sessionId>"` или `cursor-agent`
   - **codex**: `codex resume "<sessionId>" || codex`
   - **gemini**: `gemini --resume "<cliSessionId>"` или `gemini`
   - **plain-shell**: `initialCommand` передаётся напрямую (любая shell-команда)

3. Запускает процесс через `node-pty`:

```javascript
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
const shellArgs = os.platform() === 'win32'
  ? ['-Command', shellCommand]
  : ['-c', shellCommand];

shellProcess = pty.spawn(shell, shellArgs, {
  name: 'xterm-256color',
  cols: termCols,     // из init сообщения, default 80
  rows: termRows,     // из init сообщения, default 24
  cwd: resolvedProjectPath,  // рабочая директория = директория проекта
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3'
  }
});
```

**Итог:** процесс запускается как `bash -c "claude --resume \"<id>\" || claude"` в директории проекта.

### Управление сессиями PTY (кэш)

```javascript
const ptySessionsMap = new Map();
// Структура: key → { pty, ws, buffer[], timeoutId, projectPath, sessionId }
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;  // 30 минут
```

- **Ключ сессии**: `"<projectPath>_<sessionId|'default'>[_cmd_<base64hash>]"`
- **При отключении WebSocket**: PTY остаётся живым, `ws` → null. Запускается 30-минутный таймер на убийство PTY.
- **При переподключении**: существующий PTY переиспользуется, буферизованный вывод реплеируется (ring buffer, до 5000 чанков), новый `ws` присоединяется.
- **Login-команды** (`setup-token`, `cursor-agent login`, `auth login`) — всегда создают новый PTY, минуя кэш.

### Протокол WebSocket

**Endpoint:** `ws[s]://<host>/shell[?token=<jwt>]`

#### Клиент → Сервер

| type    | payload | назначение |
|---------|---------|-----------|
| `init`  | `projectPath, sessionId, hasSession, provider, cols, rows, initialCommand, isPlainShell` | Запуск/возобновление PTY сессии |
| `input` | `data: string` | Нажатия клавиш / вставка → stdin PTY |
| `resize`| `cols: number, rows: number` | Изменение размера терминала |

#### Сервер → Клиент

| type       | payload | назначение |
|------------|---------|-----------|
| `output`   | `data: string` | Сырой вывод PTY (ANSI escape sequences сохранены) |
| `auth_url` | `url: string` | OAuth/device-auth URL обнаружен в выводе |
| `url_open` | `url: string` | URL, который нужно открыть в браузере |
| `error`    | `message: string` | Ошибки валидации пути/сессии |

### Детекция URL в PTY-выводе

Сервер сканирует вывод PTY через буфер `SHELL_URL_PARSE_BUFFER_LIMIT = 32768` байт, убирает ANSI-последовательности, ищет URL по regex. При нахождении — отправляет отдельное сообщение `auth_url` или `url_open` вместе с обычным `output`.

### Детекция CLI-промптов на фронтенде

`Shell.tsx` реализует дебаунсированный сканер буфера (`PROMPT_DEBOUNCE_MS = 500мс`), который читает xterm.js буфер в поисках паттернов вида `❯ N. label` со строкой-футером "esc to cancel" / "enter to select". При обнаружении — над терминалом появляются кликабельные пронумерованные кнопки.

---

## 3. Terminal Plugin — встроенная консоль

**Отдельного "Terminal плагина" как самостоятельной системы нет.** xterm.js — это единый слой эмуляции терминала, используемый во всём приложении. Вот полная картина:

### Библиотека: `@xterm/xterm` (xterm.js v5+)

**Аддоны, загружаемые для каждого экземпляра терминала** (`useShellTerminal.ts`):

| Аддон | Пакет | Назначение |
|-------|-------|-----------|
| `FitAddon` | `@xterm/addon-fit` | Автоматически подстраивает cols/rows под размер контейнера |
| `WebLinksAddon` | `@xterm/addon-web-links` | Кликабельные URL (пропускается в minimal mode) |
| `WebglAddon` | `@xterm/addon-webgl` | GPU-ускоренный рендеринг; fallback на Canvas при ошибке |

### Настройки терминала (`constants/constants.ts`)

```typescript
{
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  allowProposedApi: true,
  allowTransparency: false,
  convertEol: true,
  scrollback: 10000,
  tabStopWidth: 4,
  windowsMode: false,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  theme: {
    background: '#1e1e1e',  // VS Code Dark+ палитра
    foreground: '#d4d4d4',
    // ... остальные цвета
  }
}
```

### Поток ввода (фронтенд → бэкенд)

1. `terminal.onData(data => sendSocketMessage(ws, { type: 'input', data }))` — каждое нажатие/вставка идёт через WebSocket.
2. **Перехват вставки**: `Ctrl/Cmd+V` перехватывается, clipboard читается через `navigator.clipboard.readText()`, вставляется как сообщение `input` (минуя стандартную вставку браузера).
3. **Копирование**: `Ctrl/Cmd+C` с выделением → копирует в clipboard; без выделения → передаёт в PTY (SIGINT).
4. **Minimal auth режим**: нажатие `c` (без модификаторов) копирует `authUrl` в clipboard вместо отправки в PTY.

### Поток изменения размера

Два механизма:
1. `ResizeObserver` на контейнере → дебаунс `TERMINAL_RESIZE_DELAY_MS = 50мс` → `fitAddon.fit()` → `sendSocketMessage(ws, { type: 'resize', cols, rows })`.
2. Начальный fit после монтирования: `setTimeout(fitAddon.fit, 100мс)` + отправка resize.

Сервер: `shellProcess.resize(data.cols, data.rows)` на `node-pty` процессе.

### Поток вывода (бэкенд → фронтенд)

1. `shellProcess.onData(data => session.ws.send(JSON.stringify({ type: 'output', data })))` — сырой PTY-вывод с ANSI отправляется как есть.
2. Фронтенд: `terminal.write(output)` — xterm.js интерпретирует ANSI и рендерит.
3. Буфер на сервере (ring buffer, max 5000 чанков) для реплея при переподключении.

### Жизненный цикл процесса

| Событие | Действие |
|---------|---------|
| **Spawn** | `node-pty` запускает `bash -c "<команда>"` (PowerShell на Windows) в директории проекта |
| **Exit** | `shellProcess.onExit({exitCode, signal})` → отправляет клиенту сообщение о выходе, удаляет из `ptySessionsMap` |
| **Disconnect** | PTY живёт ещё 30 минут. Буфер сохраняется. |
| **Reconnect** | PTY переиспользуется, буфер реплеируется. |
| **Restart** | Фронтенд: `isRestarting=true` (200мс `SHELL_RESTART_DELAY_MS`), затем `disconnectFromShell()` + `disposeTerminal()`, потом всё заново. |

---

## 4. Итоговая схема работы

```
Браузер (React/xterm.js)
        |
        | WebSocket ws://host/shell?token=<jwt>
        |
    Сервер (Node.js/Express)
        |
        | node-pty.spawn('bash', ['-c', 'claude --resume "<id>" || claude'], {
        |   cwd: /path/to/project,
        |   env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' }
        | })
        |
    PTY (псевдотерминал)
        |
    claude / cursor-agent / codex / gemini
```

**Ключевые выводы:**
1. Shell Tab и Terminal — одна и та же система: xterm.js + WebSocket + node-pty.
2. Claude Code запускается как `bash -c "claude --resume '<sessionId>' || claude"` в директории проекта.
3. PTY-сессии переживают отключение браузера на 30 минут (кэш с буфером 5000 чанков).
4. Поддерживаются несколько AI-провайдеров: claude, cursor, codex, gemini.
5. Отдельная обработка auth URL — детектируется в выводе PTY и передаётся фронтенду отдельным сообщением.
