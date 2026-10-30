---
id: CHAR-002
title: "Граф отношений: типы, доверие, валентность, история"
status: todo
priority: P0
complexity: S
phase: 2
milestone: M2
area: characters
depends_on: [CHAR-001]
modules: ["packages/core/src/characters/relationships.ts"]
assignee: null
claimed_at: null
---

# CHAR-002 — Граф отношений: типы, доверие, валентность, история

## Описание

Отношения — источник мотивов, обмена знаниями и лжи.

## Цель

Запросы к отношениям быстрые и согласованные.

## Scope

- RelationType: family (parent/child/sibling/spouse), romance, friendship, rivalry, debt, employment, blackmail, past_conflict.
- Симметричные/асимметричные типы; adjust с причиной (EventId).
- Запросы get, neighbors, byType.

## Out of Scope

- Генерация отношений (GEN-004).

## Зависимости

- [CHAR-001](CHAR-001.md) — Модель персонажа: личность, биография, цели, страхи, доступы

## Затрагиваемые модули

- `packages/core/src/characters/relationships.ts`

## Ожидаемый результат

Модуль отношений.

## Критерии приёмки

- [ ] Симметричные типы хранятся согласованно.
- [ ] trust/valence ограничены [-1, 1] / [0, 1].
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + property на симметрию.

## Требования к документации

- Отдельных изменений документации не требуется. Если реализация отклоняется от спецификации в `docs/`, обновите соответствующий документ в том же PR.
