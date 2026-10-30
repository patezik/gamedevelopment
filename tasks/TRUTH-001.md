---
id: TRUTH-001
title: "Словарь фактов (Fact) и FactId"
status: todo
priority: P0
complexity: S
phase: 2
milestone: M2
area: truth
depends_on: [CORE-002, CHAR-001, WORLD-001]
modules: ["packages/core/src/truth/facts.ts"]
assignee: null
claimed_at: null
---

# TRUTH-001 — Словарь фактов (Fact) и FactId

## Описание

Единый словарь пропозиций для истины, знаний, показаний и утверждений (truth-model.md §2).

## Цель

Все системы оперируют одним типом утверждений.

## Scope

- Fact: at, did, possessed, relation, motive, state — zod-схемы.
- Verb — расширяемый словарь глаголов.
- FactId = hashId("f", canonicalJson(fact), 16).
- Proposition и PropositionPattern (с подстановками) для запросов знаний.

## Out of Scope

- Журнал событий (TRUTH-002).

## Зависимости

- [CORE-002](CORE-002.md) — Канонический JSON, хеширование состояния и генерация ID
- [CHAR-001](CHAR-001.md) — Модель персонажа: личность, биография, цели, страхи, доступы
- [WORLD-001](WORLD-001.md) — Граф локаций: перемещения, освещение, доступ по часам и замкам

## Затрагиваемые модули

- `packages/core/src/truth/facts.ts`

## Ожидаемый результат

Модуль фактов.

## Критерии приёмки

- [ ] Одинаковые факты — одинаковый FactId.
- [ ] Pattern-матчинг покрыт тестами.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit.

## Требования к документации

- docs/investigation/truth-model.md §2.
