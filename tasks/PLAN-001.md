---
id: PLAN-001
title: "Декомпозиция бэклога фаз 8–11 по итогам MVP"
status: todo
priority: P1
complexity: M
phase: 8
milestone: M8
area: planning
depends_on: [INT-003]
modules: ["tasks/", "docs/planning/roadmap.md"]
assignee: null
claimed_at: null
---

# PLAN-001 — Декомпозиция бэклога фаз 8–11 по итогам MVP

## Описание

Задачи фаз 8–11 сейчас намеренно крупнее и малочисленнее: детали зависят от итогов MVP.

## Цель

Пост-MVP работа разбита на задачи того же качества, что и MVP.

## Scope

- Пересмотреть roadmap фаз 8–11 по отчёту плейтеста.
- Создать задачи по шаблону, проверить tasks:check.
- Обновить open-questions.md и risks.md.

## Out of Scope

- Реализация задач.

## Зависимости

- [INT-003](INT-003.md) — MVP-плейтест: чек-лист и первое полное прохождение

## Затрагиваемые модули

- `tasks/`
- `docs/planning/roadmap.md`

## Ожидаемый результат

Обновлённые roadmap и задачи.

## Критерии приёмки

- [ ] tasks:check зелёный.
- [ ] Каждая новая задача ≤ L.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- tasks:check.

## Требования к документации

- docs/planning/roadmap.md, docs/planning/risks.md.
