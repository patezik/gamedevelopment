---
id: SAVE-001
title: "Формат сохранения и replay с проверкой хеша"
status: todo
priority: P1
complexity: M
phase: 2
milestone: M2
area: engine
depends_on: [ENG-001, CORE-001]
modules: ["packages/core/src/game/save.ts"]
assignee: null
claimed_at: null
---

# SAVE-001 — Формат сохранения и replay с проверкой хеша

## Описание

ADR 0014: сохранение = seed + версия генератора + журнал действий + чекпойнт.

## Цель

Игра восстанавливается точно, а сохранение служит репро-кейсом.

## Scope

- Схема SaveFile.
- recordAction, createCheckpoint (каждые 50 действий), loadSave(save, regenerate) с повтором и сверкой хешей.
- Ошибка SAVE_DESYNC с индексом первого расхождения.

## Out of Scope

- Файловое хранение (SRV-007).
- Миграции версий (QA-004).

## Зависимости

- [ENG-001](ENG-001.md) — GameEngine: агрегат состояния, dispatch, действия move и wait
- [CORE-001](CORE-001.md) — Детерминированный PRNG sfc32 с подпотоками fork(label)

## Затрагиваемые модули

- `packages/core/src/game/save.ts`

## Ожидаемый результат

Модуль сохранений.

## Критерии приёмки

- [ ] Сохранение посреди очереди событий восстанавливается с тем же stateHash.
- [ ] Изменение одного действия в журнале → SAVE_DESYNC.
- [ ] Загрузка с чекпойнтом и без даёт одинаковый результат.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Обязательный тест 8 из time-system.md §8; property: случайные последовательности move/wait.

## Требования к документации

- ADR 0014 — при уточнениях формата.
