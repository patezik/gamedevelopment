---
id: SURV-001
title: "Показатели героя: здоровье, рассудок, усталость и модификаторы стоимости"
status: done
priority: P0
complexity: M
phase: 7
milestone: M7
area: survival
depends_on: [ENG-001, TIME-004]
modules: ["packages/core/src/survival/vitals.ts"]
assignee: claude-surv-1
claimed_at: "2026-11-23T09:24:36Z"
---

# SURV-001 — Показатели героя: здоровье, рассудок, усталость и модификаторы стоимости

## Описание

Survival-основа (survival-horror.md §1).

## Цель

Состояние героя влияет на время и восприятие.

## Scope

- Vitals и их изменения от действий/событий.
- CostModifier для TIME-004.
- Пороги и события VitalsChanged, PlayerIncapacitated.
- Концовки death и madness.

## Out of Scope

- Static (SURV-002).

## Зависимости

- [ENG-001](ENG-001.md) — GameEngine: агрегат состояния, dispatch, действия move и wait
- [TIME-004](TIME-004.md) — ActionCostTable и resolveActionCost с модификаторами

## Затрагиваемые модули

- `packages/core/src/survival/vitals.ts`

## Ожидаемый результат

Модуль показателей.

## Критерии приёмки

- [x] Табличный тест порогов survival-horror.md §1.
- [x] Отдых восстанавливает по формулам.
- [x] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit.

## Требования к документации

- docs/game-design/survival-horror.md.
