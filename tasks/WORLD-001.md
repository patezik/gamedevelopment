---
id: WORLD-001
title: "Граф локаций: перемещения, освещение, доступ по часам и замкам"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: world
depends_on: [TIME-001, CNT-001]
modules: ["packages/core/src/world/locations.ts"]
assignee: null
claimed_at: null
---

# WORLD-001 — Граф локаций: перемещения, освещение, доступ по часам и замкам

## Описание

Мир — граф локаций с временем перемещения и правилами доступа (modules.md §3).

## Цель

Перемещения и доступность вычисляются единообразно для игрока и NPC.

## Scope

- LocationGraph из контента: travelTime, path (Дейкстра, детерминированный выбор при равенстве — по id).
- Освещение по DayPeriod.
- AccessRule: часы, ключ (ItemId), разрешение персонажа; isAccessible(loc, actor, t) → { ok, reason }.
- Ошибки WORLD_UNKNOWN_LOCATION, WORLD_NO_PATH.

## Out of Scope

- Предметы (WORLD-002).

## Зависимости

- [TIME-001](TIME-001.md) — GameMinutes и Calendar: дни, часы, периоды суток
- [CNT-001](CNT-001.md) — Схемы контента сценариев (zod) и загрузчик @hs/core/content

## Затрагиваемые модули

- `packages/core/src/world/locations.ts`

## Ожидаемый результат

Модуль локаций.

## Критерии приёмки

- [ ] Путь детерминирован при равных стоимостях.
- [ ] Запертая связь непроходима без ключа.
- [ ] Тесты на _test_minimal.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit: пути, доступ, освещение.

## Требования к документации

- Отдельных изменений документации не требуется. Если реализация отклоняется от спецификации в `docs/`, обновите соответствующий документ в том же PR.
