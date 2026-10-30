---
id: KNOW-001
title: "KnowledgeStore: убеждения, источники, память с размытием"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: knowledge
depends_on: [TRUTH-001]
modules: ["packages/core/src/knowledge/store.ts"]
assignee: null
claimed_at: null
---

# KNOW-001 — KnowledgeStore: убеждения, источники, память с размытием

## Описание

Каждый персонаж знает только наблюдённое, услышанное, прочитанное или выведенное (ADR 0005).

## Цель

Субъективные знания персонажей отделены от истины.

## Scope

- Belief { proposition, confidence, source, fromCharacter?, acquiredAt, fuzzMinutes }.
- add (слияние повторов: confidence = max), query(pattern), recall(pattern, now) с размытием времени (округление до 15/30/60 минут в зависимости от fuzz).
- Затухание: fuzzMinutes растёт с прошедшим временем (формула в коде и докстринге).
- Сериализация.

## Out of Scope

- Ложь и показания (KNOW-002).

## Зависимости

- [TRUTH-001](TRUTH-001.md) — Словарь фактов (Fact) и FactId

## Затрагиваемые модули

- `packages/core/src/knowledge/store.ts`

## Ожидаемый результат

KnowledgeStore.

## Критерии приёмки

- [ ] KnowledgeStore не импортирует TruthModel (lint/тест).
- [ ] recall детерминирован.
- [ ] Убеждение может быть ложным (proposition не обязана совпадать с истиной).
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit.

## Требования к документации

- docs/simulation/character-simulation.md §2, §4.
