---
id: CORE-002
title: "Канонический JSON, хеширование состояния и генерация ID"
status: todo
priority: P0
complexity: S
phase: 2
milestone: M2
area: core
depends_on: [FND-009]
modules: ["packages/core/src/common"]
assignee: null
claimed_at: null
---

# CORE-002 — Канонический JSON, хеширование состояния и генерация ID

## Описание

Хеш состояния используется в тестах детерминизма, сохранениях и FactId (ADR 0004, 0005, 0014).

## Цель

Одинаковые структуры дают одинаковый хеш независимо от порядка ключей.

## Scope

- canonicalJson(value): сортировка ключей, запрет undefined/NaN/Infinity (ошибка).
- Интерфейс Hasher и реализация на node:crypto (sha256), функция stateHash.
- Генераторы ID: sequentialId(prefix), hashId(prefix, value, length).
- Общие типы GameMinutes, Interval и функции интервалов (overlaps, contains, intersect).

## Out of Scope

- Сериализация конкретных доменных объектов.

## Зависимости

- [FND-009](FND-009.md) — Каркасы пакетов @hs/core, @hs/generator, @hs/validator

## Затрагиваемые модули

- `packages/core/src/common`

## Ожидаемый результат

Модуль common с утилитами и тестами.

## Критерии приёмки

- [ ] canonicalJson({b:1,a:2}) === canonicalJson({a:2,b:1}).
- [ ] NaN/undefined в данных вызывают ошибку с путём к полю.
- [ ] Интервалы — полуинтервалы [from, to), граничные случаи покрыты тестами.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + property: canonicalJson(JSON.parse(canonicalJson(x))) === canonicalJson(x).

## Требования к документации

- docs/architecture/modules.md — раздел общих типов.
