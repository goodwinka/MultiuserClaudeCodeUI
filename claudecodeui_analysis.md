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

## 3. Terminal Plugin — плагин Web Terminal

**Репозиторий:** `https://github.com/cloudcli-ai/cloudcli-plugin-terminal`  
**Устанавливается в:** `~/.claude-code-ui/plugins/cloudcli-plugin-terminal/`  
**manifest.json name:** `web-terminal`

Это **отдельный плагин**, независимый от Shell Tab. Он устанавливается через Settings > Plugins по git URL. Имеет собственный PTY-сервер и собственный xterm.js на фронтенде.

---

### 3.1 Система плагинов claudecodeui

**Хранилище плагинов:**
- Код: `~/.claude-code-ui/plugins/<repo-name>/`
- Конфиг: `~/.claude-code-ui/plugins.json` (права 0o600)

**Установка (`installPluginFromGit`):**
1. `git clone --depth 1 -- <url> <tmpdir>`
2. Валидация `manifest.json`
3. `npm install --ignore-scripts` (без postinstall хуков)
4. Если есть `build` в `package.json`: `npm run build` (таймаут 60с)
5. Атомарный `rename(tmpdir, targetDir)`
6. Авто-запуск plugin server если `manifest.server` указан

**Формат `manifest.json`:**
```json
{
  "name": "web-terminal",
  "displayName": "Terminal",
  "version": "1.0.1",
  "description": "Full-featured web terminal with multi-tab support, powered by xterm.js",
  "author": "CloudCLI UI",
  "icon": "icon.svg",
  "type": "module",
  "slot": "tab",
  "entry": "dist/index.js",
  "server": "dist/server.js",
  "permissions": []
}
```

---

### 3.2 Запуск plugin subprocess (`plugin-process-manager.js`)

```javascript
spawn('node', [serverPath], {
  cwd: pluginDir,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PLUGIN_NAME: name,      // 'web-terminal'
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
```

**Протокол готовности:** плагин должен напечатать в stdout JSON-строку в течение **10 секунд**:
```json
{"ready": true, "port": 54321}
```

Порт выбирается через `server.listen(0, '127.0.0.1')` — ОС назначает свободный порт.

**Остановка:** SIGTERM → ожидание → SIGKILL через 5 секунд.

---

### 3.3 Сервер плагина (`src/server.ts`)

```typescript
// Запуск PTY
pty.spawn(SHELL, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: HOME,
  // наследует env процесса (PATH, HOME, USER, etc.)
})
```

- `SHELL` — из `process.env.SHELL` (например `/bin/bash`)
- `cwd` — из `process.env.HOME`
- Не получает путь к проекту автоматически

**WebSocket сервер плагина:** слушает на `/ws`

| Сообщение (клиент → плагин) | Описание |
|-----------------------------|---------|
| `{ type: 'input', data }` | Ввод → PTY stdin |
| `{ type: 'resize', cols, rows }` | Resize (cols: 1-500, rows: 1-200) |
| `{ type: 'ping' }` | → ответ `{ type: 'pong' }` |

| Сообщение (плагин → клиент) | Описание |
|-----------------------------|---------|
| `{ type: 'ready', sessionId, shell, cwd }` | При подключении |
| `{ type: 'output', data }` | Сырой PTY вывод |
| `{ type: 'pong' }` | Ответ на ping |

**Backpressure:** `pty.pause()` перед `ws.send()`, `pty.resume()` в колбэке отправки.

**Зависимости:** `node-pty ^1.1.0`, `ws ^8.14.0`. `findModule()` ищет их в родительских директориях (до 10 уровней), а также в `/opt/claudecodeui`, `/workspace/claudecodeui`, `~/claudecodeui`.

**Graceful shutdown (SIGTERM/SIGINT):** убивает все PTY → `server.close()` → `setTimeout(process.exit(1), 3000)`.

---

### 3.4 Проксирование через host (`server/index.js`)

**HTTP RPC:** `ALL /api/plugins/:name/rpc/*` → `http://127.0.0.1:<port>/<rpcPath>`

**WebSocket прокси:**
```javascript
// Клиент подключается к:  wss://host/plugin-ws/web-terminal?token=<jwt>
// Хост проксирует на:     ws://127.0.0.1:<port>/ws

function handlePluginWsProxy(clientWs, pathname) {
  const pluginName = pathname.replace('/plugin-ws/', '');
  const port = getPluginPort(pluginName);
  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  // двунаправленный relay без трансформации сообщений
  upstream.on('message', (data) => clientWs.send(data));
  clientWs.on('message', (data) => upstream.send(data));
}
```

Аутентификация через `verifyClient` выполняется до входа в этот обработчик.

---

### 3.5 Фронтенд плагина (`src/index.ts`)

- Состояние хранится в `window.__wtState` — переживает mount/unmount циклы
- xterm.js аддоны загружаются с CDN `esm.sh` (xterm 5.5.0, fit 0.10.0, webgl 0.18.0)
- **5 тем:** VS Dark, One Dark, Dracula, Solarized Dark, Light
- **Размер шрифта:** 8–32px, сохраняется в `localStorage['web-terminal-prefs']`
- **Mobile keybar:** ESC, TAB, CTRL, ALT, стрелки, спецсимволы
- **Горячие клавиши:** `Cmd/Ctrl+C` копирует выделение, `Cmd/Ctrl+V` вставляет, `Cmd/Ctrl+Shift+T` новая вкладка
- **Keepalive:** ping каждые 25 секунд

**Plugin API contract:**
```typescript
interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}
// api.rpc() → POST /api/plugins/web-terminal/rpc/<path>
// api.onContextChange() → получает { theme, project, session }
```

---

## 4. Итоговая схема

### Shell Tab (встроенный, Claude Code)
```
Браузер (React / xterm.js)
         |
         |  WebSocket  ws://host/shell?token=<jwt>
         |
    server/index.js  (handleShellConnection)
         |
         |  node-pty.spawn('bash', ['-c', 'claude --resume "<id>" || claude'], {
         |    cwd: /path/to/project,
         |    env: { ...process.env, TERM:'xterm-256color', COLORTERM:'truecolor', FORCE_COLOR:'3' }
         |  })
         |
    PTY-процесс: claude / cursor-agent / codex / gemini
    PTY-кэш: 30 мин, ring buffer 5000 чанков
```

### Terminal Plugin (Web Terminal)
```
Браузер (xterm.js, загружен из dist/index.js плагина)
         |
         |  WebSocket  wss://host/plugin-ws/web-terminal?token=<jwt>
         |
    server/index.js  (handlePluginWsProxy)
         |  двунаправленный relay, без трансформации
         |
    plugin subprocess  node dist/server.js
    (cwd: ~/.claude-code-ui/plugins/cloudcli-plugin-terminal/,
     env: { PATH, HOME, NODE_ENV='production', PLUGIN_NAME='web-terminal' })
         |
         |  node-pty.spawn(SHELL, [], {
         |    name: 'xterm-256color',
         |    cols:80, rows:24,
         |    cwd: HOME   // НЕ директория проекта!
         |  })
         |
    PTY-процесс: $SHELL (bash/zsh/etc.)
    Без кэша сессий — каждое подключение новый PTY
```

### Ключевые отличия Shell Tab vs Terminal Plugin

| Аспект | Shell Tab | Terminal Plugin |
|--------|-----------|-----------------|
| Что запускает | `claude` (AI CLI) | `$SHELL` (bash/zsh) |
| cwd | директория проекта | `$HOME` |
| env | `...process.env` + TERM/COLORTERM | только PATH, HOME, NODE_ENV |
| PTY-кэш | 30 мин, с буфером | нет |
| Протокол WS | JSON-сообщения (`init/input/resize/output`) | то же, через proxy |
| Интеграция | встроена в host | отдельный subprocess на случайном порту |
| Аутентификация | JWT токен в WS URL | JWT токен в WS URL (хост проверяет) |
