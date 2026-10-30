---
id: TRUTH-002
title: "TruthLog, TruthModel и IncidentRecord"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: truth
depends_on: [TRUTH-001]
modules: ["packages/core/src/truth/truth-model.ts"]
assignee: null
claimed_at: null
---

# TRUTH-002 — TruthLog, TruthModel и IncidentRecord

## Описание

Объективная истина расследования (ADR 0005).

## Цель

Все системы получают ответы «кто, где, когда, что» из одного источника.

## Scope

- append-only TruthLog; индексы присутствия и владения.
- Запросы whereWas, presenceIntervals, whoWasAt, possession, causalChain, facts(filter).
- IncidentRecord с culpritIds (массив).
- Сериализация.

## Out of Scope

- Проверка инвариантов (TRUTH-003).

## Зависимости

- [TRUTH-001](TRUTH-001.md) — Словарь фактов (Fact) и FactId

## Затрагиваемые модули

- `packages/core/src/truth/truth-model.ts`

## Ожидаемый результат

TruthModel.

## Критерии приёмки

- [ ] whereWas корректен на границах интервалов и в пути.
- [ ] causalChain возвращает события в хронологическом порядке.
- [ ] Журнал нельзя изменить после append (тест на заморозку).
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit на tiny-сценарии событий.

## Требования к документации

- docs/investigation/truth-model.md.
