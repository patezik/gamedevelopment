---
id: KNOW-002
title: "LiePolicy и показания: answer(question) → правда, ошибка или ложь"
status: todo
priority: P0
complexity: L
phase: 4
milestone: M4
area: knowledge
depends_on: [KNOW-001, CHAR-002]
modules: ["packages/core/src/knowledge/testimony.ts"]
assignee: null
claimed_at: null
---

# KNOW-002 — LiePolicy и показания: answer(question) → правда, ошибка или ложь

## Описание

Персонажи лгут только при мотиве скрывать; ошибаются из-за памяти (ADR 0005).

## Цель

Показания порождаются из знаний и секретов, а не из истины напрямую.

## Scope

- buildLiePolicy(character, knowledge, secrets, guilt): conceal и fabricate.
- Типы вопросов: whereWereYou(interval), whatDoYouKnowAbout(character), whatIsThis(clue), aboutYourself, sawAnything(interval, location).
- answer(question, ctx) → Statement[] с veracity (скрыто от клиента).
- Реакция на предъявление опровержения: признание / смена версии / отказ по личности.
- Расширить tiny-manor показаниями.

## Out of Scope

- Тексты реплик (CNT-005) — здесь только пропозиции и ключи шаблонов.

## Зависимости

- [KNOW-001](KNOW-001.md) — KnowledgeStore: убеждения, источники, память с размытием
- [CHAR-002](CHAR-002.md) — Граф отношений: типы, доверие, валентность, история

## Затрагиваемые модули

- `packages/core/src/knowledge/testimony.ts`

## Ожидаемый результат

Модуль показаний.

## Критерии приёмки

- [ ] Невиновный без секретов не лжёт (property).
- [ ] Ложь всегда относится к пропозициям из conceal/fabricate.
- [ ] Ошибка памяти не превышает fuzzMinutes.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + property.

## Требования к документации

- docs/simulation/character-simulation.md §2.
