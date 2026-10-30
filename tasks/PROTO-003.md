---
id: PROTO-003
title: "Генерация GDScript-констант протокола и контрактные тесты Godot"
status: todo
priority: P0
complexity: S
phase: 5
milestone: M5
area: protocol
depends_on: [PROTO-002, FND-008]
modules: ["packages/protocol/scripts", "apps/desktop/src/net/protocol_constants.gd", "apps/desktop/tests/contract"]
assignee: null
claimed_at: null
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

## Ожидаемый результат

Сгенерированные константы и контрактные тесты.

## Критерии приёмки

- [ ] Файл помечен «СГЕНЕРИРОВАНО — не редактировать».
- [ ] CI падает, если .gd устарел.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- GUT contract tests.

## Требования к документации

- docs/desktop/godot-client.md §2.
