---
id: TOOL-001
title: "Фейковые клиенты desktop/phone (CLI и библиотека) для тестов"
status: review
priority: P0
complexity: M
phase: 5
milestone: M5
area: tools
depends_on: [SRV-004]
modules: ["tools/fake-client"]
assignee: claude-w3
claimed_at: "2026-11-23T17:29:17Z"
---

# TOOL-001 — Фейковые клиенты desktop/phone (CLI и библиотека) для тестов

## Описание

Нужны программные клиенты для интеграционных и E2E-тестов и ручной отладки.

## Цель

Сервер тестируется без Godot и телефона.

## Scope

- Библиотека FakeDesktop/FakePhone: создать сессию, привязаться, hello, sendAction, waitForView, scanQr.
- CLI для интерактивной отладки (REPL).
- Опция случайных разрывов соединения (для хаос-теста).

## Out of Scope

- E2E-бот (INT-002).

## Зависимости

- [SRV-004](SRV-004.md) — WebSocket-шлюз: hello, роли, heartbeat, seq/ack, resume

## Затрагиваемые модули

- `tools/fake-client`

## Ожидаемый результат

Фейковые клиенты.

## Критерии приёмки

- [x] Используются хотя бы одним интеграционным тестом сервера.
- [x] Документация в README каталога.
- [x] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Self-test против реального сервера.

## Требования к документации

- tools/fake-client/README.md.
