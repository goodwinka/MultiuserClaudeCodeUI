# MultiuserClaudeCodeUI

Многопользовательский сервер [ClaudeCodeUI](https://github.com/siteboon/claudecodeui) с изоляцией сессий, встроенной аутентификацией и поддержкой локальных LLM.

## Архитектура

```
Nginx (PORT, default 80) → Auth Gateway (4000) → Process Manager → ClaudeCodeUI (10000–11000)
```

- **Nginx** — reverse proxy, поддержка WebSocket
- **Auth Gateway** (Node.js/Express) — регистрация, логин, JWT, админ-панель
- **Process Manager** — запуск/остановка изолированного ClaudeCodeUI процесса на каждого пользователя
- **SQLite** — хранилище пользователей и сессий

## Быстрый старт

```bash
cp docker-compose.yml docker-compose.override.yml  # при необходимости
docker compose up -d
```

Открыть `http://localhost/` (или `http://localhost:PORT/` если задан нестандартный порт). Войти под `admin` / паролем из `ADMIN_PASSWORD`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `80` | Порт на хосте (`http://localhost:PORT/`) |
| `ADMIN_PASSWORD` | `admin123` | Начальный пароль администратора |
| `JWT_SECRET` | `changeme-...` | Секрет для подписи JWT — **обязательно сменить** |
| `ANTHROPIC_BASE_URL` | `http://host.docker.internal:11434/v1` | Эндпоинт локальной LLM (Ollama / vLLM / llama.cpp) |
| `ANTHROPIC_API_KEY` | `local` | API-ключ для LLM |
| `SESSION_TIMEOUT_MINUTES` | `30` | Таймаут бездействия сессии |
| `MAX_SESSIONS` | `0` | Макс. одновременных сессий (0 = без ограничений) |
| `GIT_PROXY_URL` | — | HTTP(S)-прокси для git-операций, например `http://host.docker.internal:34219` |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | Общий HTTP(S)-прокси (используется git, curl, npm) |
| `NO_PROXY` | `localhost,127.0.0.1` | Исключения из прокси |

## Git

Локальный git доступен внутри контейнера без дополнительной настройки. При первом старте сессии для каждого пользователя автоматически создаётся `~/.gitconfig` с именем/email.

Для доступа к удалённым репозиториям через прокси — задать `GIT_PROXY_URL`:

```yaml
# docker-compose.yml или .env
GIT_PROXY_URL: http://host.docker.internal:34219
```

## Тома (volumes)

| Путь в контейнере | Путь на хосте | Содержимое |
|---|---|---|
| `/data/users` | `./data/users` | Проекты пользователей |
| `/var/lib/multiuser-ccui` | `./data/db` | SQLite, логи |
| `/etc/claude` | `./data/claude-config` | Глобальные настройки Claude Code |

## Изоляция пользователей

Каждый пользователь получает уникальный Linux UID (от 10000), отдельную домашнюю директорию `/data/users/{username}` и отдельный процесс ClaudeCodeUI.

## Настройка Claude Code

Редактировать `./data/claude-config/settings.json` на хосте — изменения подхватываются всеми пользователями без перезапуска контейнера.

## Структура проекта

```
Dockerfile            — образ (Ubuntu 24.04 + Node.js 22 + git + компиляторы + Claude Code CLI)
docker-compose.yml    — оркестрация
nginx/nginx.conf      — конфиг reverse proxy
gateway/
  index.js            — Auth Gateway (регистрация, JWT, маршрутизация, админ)
  processManager.js   — управление процессами, git-конфиг пользователей
  db.js               — SQLite
scripts/
  entrypoint.sh       — инициализация (git, nginx, gateway)
claude-config/
  settings.json       — шаблон глобальных настроек Claude Code
```
