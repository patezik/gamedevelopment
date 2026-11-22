---
id: CORE-003
title: "Тип Investigation и fixture-builder мини-сценария «tiny-manor»"
status: done
priority: P0
complexity: M
phase: 2
milestone: M2
area: core
depends_on: [TRUTH-002, CHAR-003, WORLD-002]
modules: ["packages/core/src/game/investigation.ts", "packages/core/test/fixtures"]
assignee: egor-codex-core-003
claimed_at: "2026-11-20T15:43:17Z"
---

# CORE-003 — Тип Investigation и fixture-builder мини-сценария «tiny-manor»

## Описание

Движок, валидатор и Investigation Engine должны тестироваться до готовности генератора. Нужен общий тип расследования и ручной мини-сценарий.

Проверка `tiny-manor` через `checkTruthInvariants` выполнена во временном worktree с [TRUTH-003](TRUTH-003.md). Воспроизведение описано в [PR #32](https://github.com/patezik/gamedevelopment/pull/32).

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

- [x] `checkTruthInvariants` возвращает пустой список для `tiny-manor` до и после сериализации во временном worktree с TRUTH-003.
- [x] Сериализация туда-обратно сохраняет stateHash.
- [x] Builder документирован JSDoc-примером.
- [x] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit: builder, сериализация.
- Постоянный интеграционный тест с `checkTruthInvariants` включается после слияния TRUTH-003.

## Требования к документации

- docs/architecture/modules.md §12 — тип Investigation.
