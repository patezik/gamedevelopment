---
id: TRUTH-003
title: "Проверка инвариантов Truth Model"
status: todo
priority: P0
complexity: S
phase: 2
milestone: M2
area: truth
depends_on: [TRUTH-002, WORLD-002]
modules: ["packages/core/src/truth/invariants.ts"]
assignee: null
claimed_at: null
---

# TRUTH-003 — Проверка инвариантов Truth Model

## Описание

7 инвариантов истины (truth-model.md §4) — фундамент валидации.

## Цель

Нарушение физики мира обнаруживается автоматически.

## Scope

- checkTruthInvariants(tm, world) → InvariantViolation[] с кодом и событиями.
- Debug-режим: assertInvariants после каждой записи (выключаем флагом).

## Out of Scope

- Остальные проверки валидатора.

## Зависимости

- [TRUTH-002](TRUTH-002.md) — TruthLog, TruthModel и IncidentRecord
- [WORLD-002](WORLD-002.md) — Предметы, контейнеры и история их перемещений

## Затрагиваемые модули

- `packages/core/src/truth/invariants.ts`

## Ожидаемый результат

Модуль инвариантов.

## Критерии приёмки

- [ ] Каждый из 7 инвариантов имеет тест «нарушение ловится» и «корректный журнал проходит».
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit на мутационных фикстурах.

## Требования к документации

- Отдельных изменений документации не требуется. Если реализация отклоняется от спецификации в `docs/`, обновите соответствующий документ в том же PR.
