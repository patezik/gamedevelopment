---
id: CORE-003
title: "Тип Investigation и fixture-builder мини-сценария «tiny-manor»"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: core
depends_on: [TRUTH-002, CHAR-003, WORLD-002]
modules: ["packages/core/src/game/investigation.ts", "packages/core/test/fixtures"]
assignee: null
claimed_at: null
---

# CORE-003 — Тип Investigation и fixture-builder мини-сценария «tiny-manor»

## Описание

Движок, валидатор и Investigation Engine должны тестироваться до готовности генератора. Нужен общий тип расследования и ручной мини-сценарий.

## Цель

Параллельная разработка движка/валидатора без ожидания генератора.

## Scope

- interface Investigation: scenarioId, seed, generatorVersion, world, characters, relationships, truth (TruthModel), secrets; поля clues, lies, phoneSeed добавляются последующими задачами как optional.
- Сериализация/десериализация Investigation через canonicalJson.
- InvestigationBuilder — fluent API для ручного построения.
- Фикстура tiny-manor: 4 локации, 4 персонажа, 1 инцидент, известный виновник, 8 событий истины.

## Out of Scope

- Улики и показания (добавляются в EVD-002, KNOW-002 расширением фикстуры).

## Зависимости

- [TRUTH-002](TRUTH-002.md) — TruthLog, TruthModel и IncidentRecord
- [CHAR-003](CHAR-003.md) — Расписания и рутины: whereShouldBe, переопределения
- [WORLD-002](WORLD-002.md) — Предметы, контейнеры и история их перемещений

## Затрагиваемые модули

- `packages/core/src/game/investigation.ts`
- `packages/core/test/fixtures`

## Ожидаемый результат

Тип и фикстура, используемые в тестах других модулей.

## Критерии приёмки

- [ ] tiny-manor проходит checkTruthInvariants (после TRUTH-003 — тест включается).
- [ ] Сериализация туда-обратно сохраняет stateHash.
- [ ] Builder документирован JSDoc-примером.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit: builder, сериализация.

## Требования к документации

- docs/architecture/modules.md §12 — тип Investigation.
