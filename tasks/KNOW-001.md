---
id: KNOW-001
title: "KnowledgeStore: убеждения, источники, память с размытием"
status: review
priority: P0
complexity: M
phase: 2
milestone: M2
area: knowledge
depends_on: [TRUTH-001]
modules: ["packages/core/src/knowledge/store.ts"]
assignee: egor-codex-1
claimed_at: "2026-11-20T14:47:12Z"
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

- [x] KnowledgeStore не импортирует TruthModel (lint/тест).
- [x] recall детерминирован.
- [x] Убеждение может быть ложным (proposition не обязана совпадать с истиной).
- [x] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit.

## Требования к документации

- docs/simulation/character-simulation.md §2, §4.
