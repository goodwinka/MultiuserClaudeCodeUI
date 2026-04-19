# MultiuserClaudeCodeUI

Многопользовательский сервер [ClaudeCodeUI](https://github.com/siteboon/claudecodeui) с изоляцией сессий, встроенной аутентификацией и поддержкой локальных LLM.

## Архитектура

```
Nginx (PORT, default 80) → Auth Gateway (4000) → Process Manager → ClaudeCodeUI (10000–11000)
```

| Компонент | Описание |
|---|---|
| **Nginx** | Reverse proxy, поддержка WebSocket |
| **Auth Gateway** | Node.js/Express — регистрация, логин, JWT, админ-панель |
| **Process Manager** | Запуск/остановка изолированного ClaudeCodeUI-процесса на каждого пользователя |
| **SQLite** | Хранилище пользователей и сессий |

---

## Быстрый старт (онлайн-сборка)

```bash
# 1. Создать директории и .env
make setup

# 2. Собрать образ и запустить
make start
```

Открыть `http://localhost/` (или `http://localhost:PORT/`).
Войти под `admin` / паролем из `ADMIN_PASSWORD` (по умолчанию `admin123`).

---

## Локальный образ: сборка, экспорт, импорт и развёртывание

Используйте этот подход, когда нет доступа к интернету на целевой машине или нужно зафиксировать конкретную версию образа.

### 1. Сборка образа

```bash
# Стандартная сборка (через docker compose)
docker compose build

# Или напрямую через Docker, с явным тегом
docker build -t multiuser-ccui:latest .

# С прокси во время сборки (если npm/apt за прокси)
docker build \
  --build-arg HTTP_PROXY=http://proxy.example.com:3128 \
  --build-arg HTTPS_PROXY=http://proxy.example.com:3128 \
  -t multiuser-ccui:latest .

# С добавлением корневого сертификата TLS-прокси
docker build \
  --build-arg EXTRA_CA_CERT="$(cat /path/to/corp-ca.pem)" \
  -t multiuser-ccui:latest .
```

### 2. Сохранение образа в файл (tar)

```bash
docker save multiuserclaudecodeui-app:latest | gzip > multiuserclaudecodeui-app.tar.gz
```

### 3. Перенос на другую машину

```bash
scp multiuserclaudecodeui-app.tar.gz user@target-host:/opt/deploy/
```

### 4. Загрузка образа на целевой машине

```bash
docker load < multiuserclaudecodeui-app.tar.gz
# или
gunzip -c multiuserclaudecodeui-app.tar.gz | docker load
```

Убедиться, что образ загружен:

```bash
docker images | grep multiuserclaudecodeui-app
```

### 5. Развёртывание из локального образа

Скопировать на целевую машину файлы проекта (`docker-compose.yml`, `.env`, `data/`) и запустить:

```bash
# Запустить без пересборки (использовать загруженный образ)
docker compose up -d
```

Чтобы `docker compose` не пересобирал образ из Dockerfile, замените секцию `build` на `image` в `docker-compose.yml`:

```yaml
services:
  app:
    image: multiuserclaudecodeui-app:latest   # ← вместо "build: ."
    ports:
      - "${PORT:-80}:80"
    # ... остальное без изменений
```

### 6. Обновление образа

```bash
# Пересобрать и перезапустить
docker compose down
docker compose build --no-cache
docker compose up -d

# Или одной командой
make start
```

---

## Переменные окружения

Задаются в `.env` (скопировать из `.env.example`) или напрямую в `docker-compose.yml`.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `80` | Порт на хосте |
| `ADMIN_PASSWORD` | `admin123` | Начальный пароль администратора — **сменить при первом входе** |
| `JWT_SECRET` | `changeme-...` | Секрет JWT — **обязательно сменить в production** |
| `ANTHROPIC_BASE_URL` | `http://host.docker.internal:11434/v1` | Эндпоинт локальной LLM (Ollama / vLLM / llama.cpp) |
| `ANTHROPIC_API_KEY` | `local` | API-ключ LLM |
| `SESSION_TIMEOUT_MINUTES` | `30` | Таймаут бездействия сессии (мин.) |
| `MAX_SESSIONS` | `0` | Макс. одновременных сессий (0 = без ограничений) |
| `DATA_DIR` | `./data` | Корневая директория данных на хосте |
| `GIT_PROXY_URL` | — | HTTP(S)-прокси для git-операций, например `http://host.docker.internal:34219` |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | Общий HTTP(S)-прокси (git, curl, npm) |
| `NO_PROXY` | `localhost,127.0.0.1` | Исключения из прокси |
| `NVIDIA_VISIBLE_DEVICES` | `all` | Видимые GPU (требуется nvidia-container-toolkit) |

---

## GPU (NVIDIA)

По умолчанию `docker-compose.yml` запрашивает NVIDIA runtime. Если GPU на хосте нет:

1. Закомментировать `runtime: nvidia` в `docker-compose.yml`.
2. Закомментировать монтирование `/usr/local/cuda`.

Для включения GPU установить [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html):

```bash
sudo apt install nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

---

## Инструменты тестирования

В образ встроены инструменты для тестирования кода на C, C++, Qt и Python.

### C / C++

| Инструмент | Пакет | Назначение |
|---|---|---|
| **Google Test / Mock** | `libgtest-dev`, `libgmock-dev` | Юнит-тесты и моки для C++ |
| **CppUnit** | `libcppunit-dev` | Альтернативный фреймворк C++ (JUnit-style) |
| **Check** | `check` | Юнит-тесты для чистого C |
| **Valgrind** | `valgrind` | Анализ утечек памяти и ошибок |
| **lcov / gcovr** | `lcov`, `gcovr` | Отчёты покрытия кода (gcov) |

Google Test собирается как shared library (`libgtest.so`, `libgmock.so`) и установлен в `/usr/local/lib`.

Пример сборки и запуска тестов на C++:

```bash
# CMakeLists.txt — подключить GTest:
# find_package(GTest REQUIRED)
# target_link_libraries(my_tests GTest::gtest_main GTest::gmock)

cmake -B build && cmake --build build
./build/my_tests

# Покрытие:
cmake -B build -DCMAKE_CXX_FLAGS="--coverage"
cmake --build build && ./build/my_tests
gcovr --html-details coverage.html
```

### Qt (QTest)

| Инструмент | Пакет | Назначение |
|---|---|---|
| **QTest** | `qtbase5-dev` + `libqt5test5` | Встроенный фреймворк Qt для юнит-тестов |

```bash
# В .pro-файле добавить:
# QT += testlib
# CONFIG += testcase

qmake && make
./my_qt_tests
```

### Python

| Инструмент | Назначение |
|---|---|
| **pytest** | Основной фреймворк тестирования |
| **pytest-cov** | Покрытие кода внутри pytest |
| **pytest-xdist** | Параллельный запуск тестов (`-n auto`) |
| **coverage** | Детальные отчёты покрытия |
| **unittest-xml-reporting** | XML-отчёты (JUnit) для CI |

```bash
pytest                          # запустить все тесты
pytest -v                       # с подробным выводом
pytest --cov=src --cov-report=html   # с отчётом покрытия
pytest -n auto                  # параллельный запуск
python -m coverage run -m pytest && python -m coverage report
```

---

## Git

Локальный git доступен внутри контейнера без дополнительной настройки.
При первом старте сессии для каждого пользователя автоматически создаётся `~/.gitconfig`.

Для доступа к удалённым репозиториям через прокси — задать `GIT_PROXY_URL`:

```bash
# .env
GIT_PROXY_URL=http://host.docker.internal:34219
```

---

## Тома (volumes)

| Путь в контейнере | Путь на хосте (по умолчанию) | Содержимое |
|---|---|---|
| `/data/users` | `./data/users` | Проекты пользователей |
| `/var/lib/multiuser-ccui` | `./data/db` | SQLite, логи |
| `/etc/claude` | `./data/claude-config` | Глобальные настройки Claude Code |
| `/usr/local/cuda` | `/usr/local/cuda` (host, ro) | CUDA Toolkit (опционально) |

---

## Настройка Claude Code

Редактировать `./data/claude-config/settings.json` на хосте — изменения подхватываются всеми пользователями без перезапуска контейнера.

> **⚠️ MCP-серверы — общий секрет.**
> MCP-серверы, настроенные через админ-панель, пишутся в `/data/.mcp.json` и читаются процессами всех пользователей (иначе их `claude` не сможет их запустить). Токены/ключи в `env` / `headers` MCP-сервера фактически **общие** для всех учёток этого инстанса. Не кладите в глобальные MCP-конфиги персональные секреты.

---

## Изоляция пользователей

Каждый пользователь получает уникальный Linux UID (от 10000), отдельную домашнюю директорию `/data/users/{username}` и отдельный процесс ClaudeCodeUI.

---

## Команды Makefile

| Команда | Действие |
|---|---|
| `make setup` | Создать директории и `.env` из примера |
| `make start` | `setup` + пересобрать образ и запустить |
| `make stop` | Остановить контейнер |
| `make restart` | Перезапустить контейнер |
| `make build` | Пересобрать образ без запуска |
| `make logs` | Следить за логами |

---

## Структура проекта

```
Dockerfile                — образ (Ubuntu 24.04 + Node.js 22 + git + LSP + Claude Code CLI)
docker-compose.yml        — оркестрация
Makefile                  — утилитарные команды
nginx/nginx.conf          — конфиг reverse proxy
gateway/
  index.js                — Auth Gateway (регистрация, JWT, маршрутизация, админ)
  processManager.js       — управление процессами, git-конфиг пользователей
  db.js                   — SQLite
scripts/
  entrypoint.sh           — инициализация (git, nginx, gateway)
claude-config/
  settings.json           — шаблон глобальных настроек Claude Code
data/                     — runtime-данные (gitignored)
  users/                  — проекты пользователей
  db/                     — SQLite + логи
  claude-config/          — настройки Claude Code
```
