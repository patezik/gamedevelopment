---
id: PROTO-003
title: "Генерация GDScript-констант протокола и контрактные тесты Godot"
status: review
priority: P0
complexity: S
phase: 5
milestone: M5
area: protocol
depends_on: [PROTO-002, FND-008]
modules: ["packages/protocol/scripts", "apps/desktop/src/net/protocol_constants.gd", "apps/desktop/tests/contract", ".github/workflows/ci.yml"]
assignee: egor-claude-proto-003
claimed_at: "2026-11-20T16:55:56Z"
---

# PROTO-003 — Генерация GDScript-констант протокола и контрактные тесты Godot

## Описание

Godot использует протокол без ручного копирования строк (ADR 0009).

## Цель

Изменение протокола автоматически отражается в Godot и ломает контрактные тесты при несовместимости.

## Scope

- Скрипт protocol:gen генерирует protocol_constants.gd (типы сообщений, ErrorCode, PROTOCOL_VERSION, роли действий).
- GUT-тест: каждая фикстура из packages/protocol/fixtures разбирается JSON и содержит обязательные поля.
- protocol:check сравнивает и .gd-файл.

## Out of Scope

- Сетевой клиент Godot (GDT-001).

## Зависимости

- [PROTO-002](PROTO-002.md) — Схемы PlayerView и PhoneView с фикстурами
- [FND-008](FND-008.md) — GUT 9.7.x, headless-запуск тестов Godot и CI-job

## Затрагиваемые модули

- `packages/protocol/scripts`
- `apps/desktop/src/net/protocol_constants.gd`
- `apps/desktop/tests/contract`
- `.github/workflows/ci.yml` — фильтр `NODE_PATHS`: сгенерированный `protocol_constants.gd`
  лежит вне путей Node job, а его актуальность проверяют тесты этой job (добавлено по ревью PR).

## Ожидаемый результат

Сгенерированные константы и контрактные тесты.

## Критерии приёмки

- [x] Файл помечен «СГЕНЕРИРОВАНО — не редактировать».
- [x] CI падает, если .gd устарел.
- [x] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- GUT contract tests.

## Требования к документации

- docs/desktop/godot-client.md §2.
