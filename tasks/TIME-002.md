---
id: TIME-002
title: "Scheduler: детерминированная очередь событий"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: time
depends_on: [TIME-001, CORE-002]
modules: ["packages/core/src/time/scheduler.ts"]
assignee: null
claimed_at: null
---

# TIME-002 — Scheduler: детерминированная очередь событий

## Описание

Все отложенные события мира проходят через одну очередь с фиксированным порядком (time-system.md §2).

## Цель

Одновременные события всегда обрабатываются в одном и том же порядке.

## Scope

- schedule, cancel, peek, popDue(t); ключ сортировки (at, phase, priority, seq).
- Бинарная куча или отсортированный массив (обосновать в PR).
- Сериализация/восстановление, включая счётчик seq.
- Ошибка SCHEDULER_PAST_EVENT при планировании в прошлое относительно текущего времени.

## Out of Scope

- Обработчики фаз (TIME-003).

## Зависимости

- [TIME-001](TIME-001.md) — GameMinutes и Calendar: дни, часы, периоды суток
- [CORE-002](CORE-002.md) — Канонический JSON, хеширование состояния и генерация ID

## Затрагиваемые модули

- `packages/core/src/time/scheduler.ts`

## Ожидаемый результат

Scheduler с тестами порядка и сериализации.

## Критерии приёмки

- [ ] События с одинаковым at сортируются по phase, затем priority, затем seq.
- [ ] cancel удаляет событие; повторный cancel → false.
- [ ] serialize/restore даёт идентичный порядок дальнейших popDue.
- [ ] 100 000 schedule+pop < 200 мс.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + property: popDue возвращает события в неубывающем порядке ключа.

## Требования к документации

- Отдельных изменений документации не требуется. Если реализация отклоняется от спецификации в `docs/`, обновите соответствующий документ в том же PR.
