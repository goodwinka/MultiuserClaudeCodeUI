# Анализ репозитория siteboon/claudecodeui

Источник: https://github.com/siteboon/claudecodeui  
Версия: @siteboon/claude-code-ui v1.27.1 | Лицензия: AGPL-3.0

---

## 1. Общая структура

**Стек:** React 18 + TypeScript + Vite (фронтенд), Node.js + Express (бэкенд), xterm.js (терминал), node-pty (PTY), WebSocket (`ws`), SQLite.

```
server/       Node.js бэкенд (Express + WS + PTY)
src/          React фронтенд
plugins/      Система плагинов (git submodule)
shared/       Общие утилиты
```

**Поддерживаемые AI-провайдеры:** claude, cursor-agent, codex, gemini.

---

## 2. Shell Tab — встроенная консоль Claude Code

### Ключевые файлы фронтенда

| Файл | Роль |
|------|------|
| `src/components/shell/view/Shell.tsx` | Главный React-компонент: терминал, оверлеи, кнопки-промпты |
| `src/components/shell/hooks/useShellRuntime.ts` | Оркестрирует terminal + connection хуки |
| `src/components/shell/hooks/useShellTerminal.ts` | Жизненный цикл xterm.js: создание/уничтожение, аддоны, клавиатура, resize |
| `src/components/shell/hooks/useShellConnection.ts` | Жизненный цикл WebSocket: connect → `init` → `output`/`auth_url` |
| `src/components/shell/utils/socket.ts` | URL билдер + хелперы сообщений |
| `src/components/shell/constants/constants.ts` | Настройки терминала (шрифт, цвета, scrollback=10000), таймауты |

### Поток инициализации

1. `Shell.tsx` рендерится с props: `selectedProject`, `selectedSession`, `initialCommand`, `isPlainShell`, `autoConnect`.
2. `useShellTerminal` инициализирует xterm.js `Terminal`, монтирует в DOM. Загружаются аддоны: `FitAddon`, `WebLinksAddon`, `WebglAddon` (fallback → Canvas).
3. `useShellConnection.connectToShell()` открывает WebSocket на `/shell?token=<jwt>`.
4. При `socket.onopen`, через 100мс (`TERMINAL_INIT_DELAY_MS`), отправляется **`init` сообщение**:

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

### Запуск процесса на сервере (`server/index.js` → `handleShellConnection`)

Команда в зависимости от `provider`:

| provider | команда |
|----------|---------|
| `claude` | `claude --resume "<sessionId>" \|\| claude` |
| `cursor` | `cursor-agent --resume="<sessionId>"` или `cursor-agent` |
| `codex`  | `codex resume "<sessionId>" \|\| codex` |
| `gemini` | `gemini --resume "<cliSessionId>"` или `gemini` |
| `plain-shell` | `initialCommand` напрямую |

Запуск через `node-pty`:

```javascript
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

shellProcess = pty.spawn(shell, ['-c', shellCommand], {
  name: 'xterm-256color',
  cols: termCols,         // из init сообщения, default 80
  rows: termRows,         // из init сообщения, default 24
  cwd: resolvedProjectPath,  // рабочая директория проекта
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3'
  }
});
```

Итог: `bash -c "claude --resume \"<id>\" || claude"` в директории проекта.

### PTY-кэш и управление сессиями

```javascript
const ptySessionsMap = new Map();
// key → { pty, ws, buffer[], timeoutId, projectPath, sessionId }
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;  // 30 минут
```

- **Ключ:** `"<projectPath>_<sessionId|'default'>[_cmd_<base64hash>]"`
- **Отключение WebSocket:** PTY остаётся живым. Таймер 30 минут на уничтожение.
- **Переподключение:** PTY переиспользуется. Ring buffer (до 5000 чанков) реплеируется.
- **Login-команды** (`setup-token`, `auth login`, ...): всегда новый PTY, минуя кэш.

### Протокол WebSocket

**Endpoint:** `ws[s]://<host>/shell[?token=<jwt>]`

#### Клиент → Сервер

| type     | payload | назначение |
|----------|---------|-----------|
| `init`   | `projectPath, sessionId, hasSession, provider, cols, rows, initialCommand, isPlainShell` | Запуск/возобновление PTY |
| `input`  | `data: string` | Нажатия клавиш / вставка → stdin PTY |
| `resize` | `cols: number, rows: number` | Изменение размера |

#### Сервер → Клиент

| type       | payload | назначение |
|------------|---------|-----------|
| `output`   | `data: string` | Сырой PTY-вывод (ANSI сохранены) |
| `auth_url` | `url: string` | OAuth/device-auth URL из вывода PTY |
| `url_open` | `url: string` | URL для открытия в браузере |
| `error`    | `message: string` | Ошибки валидации |

**Детекция URL:** сервер сканирует вывод PTY через буфер 32768 байт, убирает ANSI, ищет URL по regex → отправляет `auth_url` или `url_open`.

**Детекция CLI-промптов на фронтенде:** `Shell.tsx` дебаунсированно (500мс) сканирует xterm.js буфер в поисках паттернов `❯ N. label` + "esc to cancel". При нахождении — рисует кликабельные кнопки поверх терминала.

---

## 3. Terminal (xterm.js) — слой эмуляции терминала

Отдельного "Terminal плагина" нет — xterm.js это единый слой эмуляции, используемый во всём приложении через хук `useShellTerminal.ts`.

### Аддоны

| Аддон | Пакет | Назначение |
|-------|-------|-----------|
| `FitAddon` | `@xterm/addon-fit` | Авто-resize cols/rows под контейнер |
| `WebLinksAddon` | `@xterm/addon-web-links` | Кликабельные URL (пропускается в minimal mode) |
| `WebglAddon` | `@xterm/addon-webgl` | GPU-ускоренный рендеринг; fallback на Canvas |

### Настройки (`constants/constants.ts`)

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
  theme: { background: '#1e1e1e', foreground: '#d4d4d4' }  // VS Code Dark+
}
```

### Поток ввода (фронтенд → бэкенд)

1. `terminal.onData(data => sendSocketMessage(ws, { type: 'input', data }))` — каждое нажатие через WS.
2. `Ctrl/Cmd+V` перехватывается → `navigator.clipboard.readText()` → `input` сообщение.
3. `Ctrl/Cmd+C` с выделением → копирует; без выделения → SIGINT в PTY.
4. Minimal auth режим: `c` без модификаторов → копирует `authUrl` в clipboard.

### Поток resize

- `ResizeObserver` на контейнере → дебаунс 50мс → `fitAddon.fit()` → `{ type: 'resize', cols, rows }` в WS.
- Сервер: `shellProcess.resize(cols, rows)`.

### Поток вывода (бэкенд → фронтенд)

- `shellProcess.onData(data → ws.send({ type: 'output', data }))` — сырые ANSI-данные.
- Фронтенд: `terminal.write(output)` — xterm.js рендерит.
- Ring buffer 5000 чанков на сервере для replay при переподключении.

### Жизненный цикл процесса

| Событие | Действие |
|---------|---------|
| Spawn | `node-pty` → `bash -c "<cmd>"` в cwd=проект |
| Exit | Сообщение клиенту, удаление из `ptySessionsMap` |
| Disconnect | PTY живёт 30 мин, буфер сохраняется |
| Reconnect | PTY переиспользуется, буфер реплеируется |
| Restart (фронтенд) | 200мс задержка → `disconnectFromShell()` + `disposeTerminal()` → заново |

---

## 4. Итоговая схема

```
Браузер (React / xterm.js)
         |
         |  WebSocket  ws://host/shell?token=<jwt>
         |
    Сервер (Node.js / server/index.js)
         |
         |  node-pty.spawn('bash', ['-c', 'claude --resume "<id>" || claude'], {
         |    cwd: /path/to/project,
         |    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' }
         |  })
         |
    PTY-процесс: claude / cursor-agent / codex / gemini
```
