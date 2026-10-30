---
id: PROTO-002
title: "Схемы PlayerView и PhoneView с фикстурами"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: protocol
depends_on: [PROTO-001]
modules: ["packages/protocol/src/views"]
assignee: null
claimed_at: null
---

# PROTO-002 — Схемы PlayerView и PhoneView с фикстурами

## Описание

Представления — единственное, что видят клиенты.

## Цель

Godot и мобильное приложение разрабатываются по фикстурам параллельно с ядром.

## Scope

- PlayerView и PhoneView по protocol.md §6 (детализировать вложенные типы).
- Фикстуры: начало игры, середина (5 улик, звонок), концовка.
- Запрет полей истины в схемах (тест по ключам).

## Out of Scope

- Вычисление представлений (ENG-002, PHONE-001).

## Зависимости

- [PROTO-001](PROTO-001.md) — Каталог сообщений протокола (hello, welcome, action, event, qr, error)

## Затрагиваемые модули

- `packages/protocol/src/views`

## Ожидаемый результат

Схемы и фикстуры представлений.

## Критерии приёмки

- [ ] 3+ фикстуры каждого представления.
- [ ] Тест запрета ключей истины.
- [ ] Схемы экспортированы в JSON Schema.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit.

## Требования к документации

- docs/backend/protocol.md §6.
