---
id: PROTO-006
title: "REST-схемы в @hs/protocol: JSON Schema и фикстуры для Godot"
status: in_progress
priority: P2
complexity: S
phase: 5
milestone: M5
area: protocol
depends_on: [SRV-002]
modules: ["packages/protocol/src/rest.ts", "packages/protocol/schemas", "packages/protocol/fixtures/rest", "apps/server/src/routes/sessions.ts", "apps/server/src/pairing/index.ts", "apps/server/src/saves/routes.ts", "apps/server/src/qr/routes.ts", "apps/server/src/diagnostics/debug.ts", "apps/server/src/app.ts"]
assignee: claude-p1
claimed_at: "2026-11-26T15:16:04Z"
---

# PROTO-006 — REST-схемы в @hs/protocol: JSON Schema и фикстуры для Godot

## Описание

Сообщения WebSocket описаны zod-схемами в `@hs/protocol`, а у REST (backend.md §3) общих схем нет:
каждый маршрут сервера проверяет тело сам, а Godot и мобильное приложение знают форму ответов только
из документации. SRV-002 описал схемы `POST /sessions` и `GET /scenarios` в
`apps/server/src/routes/sessions.ts`; клиентам они недоступны.

Решение владельца от 26.11.2026: `/health` и `/network` входят в общий контракт, отладочные `debug/*` остаются серверными; `error.atAction` — необязательное поле общей ошибки. Порядок SRV-002 → PROTO-006 сохранён. Исходные вопросы:

- входят ли в пакет `/health`, `/network` и отладочные `debug/*` или только игровые маршруты;
- как описать расширение формата ошибки `SAVE_DESYNC` полем `error.atAction` (общая схема ошибки
  с необязательными полями или отдельная схема для этого кода);
- порядок относительно SRV-002 (см. «Зависимости»): от него зависит, можно ли начинать задачу до
  приёмки SRV-002.

## Цель

Клиенты REST и сервер проверяют запросы и ответы одними схемами, а Godot получает фикстуры ответов
для GUT-тестов, как для сообщений WebSocket (ADR 0009).

## Scope

- zod-схемы запросов и ответов REST из backend.md §3 (сессии, сценарии, привязка, сохранения, QR)
  и общий формат ошибки `{ error: { code, message } }` в `@hs/protocol`.
- Экспорт JSON Schema через `protocol:gen` и фикстуры ответов.
- Сервер использует схемы из пакета вместо локальных (`routes/sessions.ts` и другие маршруты).

## Out of Scope

- Изменение формы ответов.
- Клиент REST в Godot (GDT-003).

## Зависимости

- [SRV-002](SRV-002.md) — REST: создание сессии и список сценариев

Зависимость предполагает, что SRV-002 принимается со схемами контракта в
`apps/server/src/routes/sessions.ts`, а эта задача переносит их в пакет. Если владелец требует для
критерия SRV-002 «Ответ проходит схему протокола» именно схему из `@hs/protocol`, зависимость нужно
развернуть (эта задача — без зависимости от SRV-002, SRV-002 — от этой), иначе задачи блокируют
друг друга.

## Затрагиваемые модули

- `packages/protocol/src/rest.ts`
- `packages/protocol/schemas`
- `packages/protocol/fixtures/rest`
- Маршруты сервера, которые переходят на схемы пакета: `apps/server/src/routes/sessions.ts`,
  `apps/server/src/pairing/index.ts`, `apps/server/src/saves/routes.ts`,
  `apps/server/src/qr/routes.ts`, `apps/server/src/diagnostics/debug.ts`, `apps/server/src/app.ts`
  (`/health`, `/network`) — состав зависит от решения владельца выше.

## Ожидаемый результат

Схемы REST лежат в `@hs/protocol` рядом со схемами WebSocket.

## Критерии приёмки

- [ ] Каждый эндпоинт backend.md §3 имеет схему ответа и фикстуру, проходящую её. _Сделано для всех, кроме `debug/truth` и `debug/export`: ждут решения владельца (OQ-30), в пакет не включены._
- [x] Integration-тесты сервера проверяют ответы схемами пакета.
- [x] `npm run protocol:check`, `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Контрактные тесты фикстур; integration (inject) сервера по схемам пакета.

## Требования к документации

- docs/backend/protocol.md, docs/backend/backend.md §3.
