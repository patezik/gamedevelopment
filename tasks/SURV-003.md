---
id: SURV-003
title: "Угрозы: нападение виновника, опасные локации, исход столкновения"
status: todo
priority: P1
complexity: M
phase: 7
milestone: M7
area: survival
depends_on: [SURV-001, SIM-006]
modules: ["packages/core/src/survival/threats.ts", "packages/core/src/simulation/goals/confront-player.ts"]
assignee: null
claimed_at: null
---

# SURV-003 — Угрозы: нападение виновника, опасные локации, исход столкновения

## Описание

Человеческая угроза (survival-horror.md §4).

## Цель

Близость к разгадке опасна.

## Scope

- Цель ConfrontPlayer у виновника.
- resolveThreat: бегство/урон/потеря предмета; след нападения.
- Опасные локации без фонаря.
- Прерывание текущего действия.

## Out of Scope

- Сверхъестественные угрозы.

## Зависимости

- [SURV-001](SURV-001.md) — Показатели героя: здоровье, рассудок, усталость и модификаторы стоимости
- [SIM-006](SIM-006.md) — Реакции NPC на игрока: настороженность, AvoidPlayer, реакции на обвинение

## Затрагиваемые модули

- `packages/core/src/survival/threats.ts`
- `packages/core/src/simulation/goals/confront-player.ts`

## Ожидаемый результат

Модуль угроз.

## Критерии приёмки

- [ ] Нападение всегда оставляет улику.
- [ ] Детерминизм исходов.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + сценарный.

## Требования к документации

- docs/game-design/survival-horror.md §4.
