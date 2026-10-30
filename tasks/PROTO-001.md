---
id: PROTO-001
title: "Каталог сообщений протокола (hello, welcome, action, event, qr, error)"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: protocol
depends_on: [FND-004]
modules: ["packages/protocol/src/messages"]
assignee: null
claimed_at: null
---

# PROTO-001 — Каталог сообщений протокола (hello, welcome, action, event, qr, error)

## Описание

Все типы сообщений из docs/backend/protocol.md §3.

## Цель

Сервер и клиенты валидируют сообщения общими схемами.

## Scope

- zod-схемы всех сообщений клиент→сервер и сервер→клиент.
- Схема PlayerAction (дискриминированное объединение всех действий из protocol.md §4) и ролевая таблица допустимых действий.
- Фикстуры: валидный пример каждого сообщения.
- parseClientMessage / parseServerMessage с ошибкой INVALID_MESSAGE.

## Out of Scope

- Представления (PROTO-002).

## Зависимости

- [FND-004](FND-004.md) — Пакет @hs/protocol: конверт, ErrorCode, версия, экспорт JSON Schema

## Затрагиваемые модули

- `packages/protocol/src/messages`

## Ожидаемый результат

Каталог сообщений.

## Критерии приёмки

- [ ] Каждое сообщение имеет фикстуру, проходящую схему.
- [ ] Ролевая таблица экспортируется как данные.
- [ ] JSON Schema регенерирована.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit: валидные/невалидные примеры каждого типа.

## Требования к документации

- docs/backend/protocol.md — синхронизировать.
