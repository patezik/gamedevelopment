---
id: PROTO-005
title: "REST-схемы в @hs/protocol: JSON Schema и фикстуры для Godot"
status: todo
priority: P2
complexity: S
phase: 5
milestone: M5
area: protocol
depends_on: [SRV-002]
modules: ["packages/protocol/src/rest.ts", "packages/protocol/schemas", "packages/protocol/fixtures/rest"]
assignee: null
claimed_at: null
---

# PROTO-005 — REST-схемы в @hs/protocol: JSON Schema и фикстуры для Godot

## Описание

Сообщения WebSocket описаны zod-схемами в `@hs/protocol`, а у REST (backend.md §3) общих схем нет:
каждый маршрут сервера проверяет тело сам, а Godot и мобильное приложение знают форму ответов только
из документации. SRV-002 описал схемы `POST /sessions` и `GET /scenarios` в
`apps/server/src/routes/sessions.ts`; клиентам они недоступны.

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

## Затрагиваемые модули

- `packages/protocol/src/rest.ts`
- `packages/protocol/schemas`
- `packages/protocol/fixtures/rest`

## Ожидаемый результат

Схемы REST лежат в `@hs/protocol` рядом со схемами WebSocket.

## Критерии приёмки

- [ ] Каждый эндпоинт backend.md §3 имеет схему ответа и фикстуру, проходящую её.
- [ ] Integration-тесты сервера проверяют ответы схемами пакета.
- [ ] `npm run protocol:check`, `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Контрактные тесты фикстур; integration (inject) сервера по схемам пакета.

## Требования к документации

- docs/backend/protocol.md, docs/backend/backend.md §3.
