---
id: TIME-004
title: "ActionCostTable и resolveActionCost с модификаторами"
status: todo
priority: P0
complexity: S
phase: 2
milestone: M2
area: time
depends_on: [TIME-001, CNT-001]
modules: ["packages/core/src/time/action-cost.ts"]
assignee: null
claimed_at: null
---

# TIME-004 — ActionCostTable и resolveActionCost с модификаторами

## Описание

Каждое действие имеет временную стоимость из данных; клиент видит оценку до подтверждения.

## Цель

Стоимости прозрачны, предсказуемы и настраиваются данными.

## Scope

- Схема ActionCostTable (дефолты ядра + переопределение пресетом).
- resolveActionCost(action, ctx) → { min, max, expected } в целых минутах.
- Интерфейс CostModifier (используется survival, освещением).
- Для move — стоимость из графа (через интерфейс TravelTimeProvider).

## Out of Scope

- Конкретные модификаторы выживания (SURV-001).

## Зависимости

- [TIME-001](TIME-001.md) — GameMinutes и Calendar: дни, часы, периоды суток
- [CNT-001](CNT-001.md) — Схемы контента сценариев (zod) и загрузчик @hs/core/content

## Затрагиваемые модули

- `packages/core/src/time/action-cost.ts`

## Ожидаемый результат

Резолвер стоимостей.

## Критерии приёмки

- [ ] Все действия из docs/game-design/game-design.md §2 имеют дефолт.
- [ ] Модификаторы применяются в фиксированном порядке и округляются до целых.
- [ ] Неизвестное действие → ошибка ACTION_INVALID.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Табличный тест: каждое действие × набор модификаторов.

## Требования к документации

- docs/simulation/time-system.md §3.
