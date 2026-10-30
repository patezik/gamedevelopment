---
id: CORE-001
title: "Детерминированный PRNG sfc32 с подпотоками fork(label)"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: core
depends_on: [FND-009]
modules: ["packages/core/src/rng"]
assignee: null
claimed_at: null
---

# CORE-001 — Детерминированный PRNG sfc32 с подпотоками fork(label)

## Описание

Основа детерминизма (ADR 0004): все случайные решения ядра, генератора и симуляции идут через Rng.

## Цель

Один seed даёт одинаковые последовательности на любой машине; подпотоки независимы.

## Scope

- cyrb128 для хеширования строкового seed; sfc32 генератор.
- API Rng из docs/architecture/modules.md §1: nextU32, float, int, chance, pick, weighted, shuffle, fork, state.
- restoreRng(state).
- Ошибки RangeError для пустых списков и неположительных весов.

## Out of Scope

- Криптографическая стойкость.

## Зависимости

- [FND-009](FND-009.md) — Каркасы пакетов @hs/core, @hs/generator, @hs/validator

## Затрагиваемые модули

- `packages/core/src/rng`

## Ожидаемый результат

Модуль rng с полным API и тестами.

## Критерии приёмки

- [ ] Golden-значения первых 10 nextU32 для seed "alpha" и "beta" зафиксированы в тесте.
- [ ] fork("a") и fork("b") дают разные последовательности; fork не сдвигает родительский поток.
- [ ] restoreRng(state) продолжает последовательность точно.
- [ ] int(min,max) включает границы; распределение проходит χ²-тест на 10⁵ выборках (p > 0.01).
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + property (fast-check): shuffle — перестановка; weighted никогда не выбирает вес 0.

## Требования к документации

- docs/architecture/modules.md §1 — если API уточнён.
