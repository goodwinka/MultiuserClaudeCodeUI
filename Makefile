DATA_DIR ?= ./data

# Load DATA_DIR from .env if it exists
-include .env
export DATA_DIR

.PHONY: setup start stop restart build logs

## Создать нужные директории на хосте и скопировать .env
setup:
	@echo "==> Creating data directories in $(DATA_DIR)"
	mkdir -p $(DATA_DIR)/users $(DATA_DIR)/db $(DATA_DIR)/claude-config
	@if [ ! -f .env ]; then \
	  cp .env.example .env; \
	  echo "==> Created .env from .env.example — проверьте настройки перед запуском"; \
	fi

## Собрать образ и запустить контейнер (с предварительным созданием директорий)
start: setup
	docker compose up -d --build

## Остановить контейнер
stop:
	docker compose down

## Перезапустить контейнер
restart:
	docker compose restart

## Пересобрать образ без запуска
build:
	docker compose build

## Показать логи
logs:
	docker compose logs -f
