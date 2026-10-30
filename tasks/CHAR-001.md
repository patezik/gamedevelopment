---
id: CHAR-001
title: "Модель персонажа: личность, биография, цели, страхи, доступы"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: characters
depends_on: [CNT-001]
modules: ["packages/core/src/characters/character.ts"]
assignee: null
claimed_at: null
---

# CHAR-001 — Модель персонажа: личность, биография, цели, страхи, доступы

## Описание

Каждый персонаж — полноценный участник мира, а не «подозреваемый» (investigation-model.md §1).

## Цель

Единая сериализуемая модель персонажа для генерации, симуляции и показаний.

## Scope

- Character из modules.md §4: personality (8 черт 0..1), biography (BiographyFact с тегами), goals, fears, habits, desires, secrets (ссылки), access, socialStatus, routine.
- zod-схема и сериализация.
- Отсутствие любых полей «suspect», «culprit», «role в преступлении» — проверка тестом по ключам схемы.

## Out of Scope

- Генерация персонажей (GEN-003).
- Расписания (CHAR-003).

## Зависимости

- [CNT-001](CNT-001.md) — Схемы контента сценариев (zod) и загрузчик @hs/core/content

## Затрагиваемые модули

- `packages/core/src/characters/character.ts`

## Ожидаемый результат

Модель и схема персонажа.

## Критерии приёмки

- [ ] Схема отклоняет черты вне 0..1.
- [ ] Тест: в схеме нет ключей, содержащих suspect/culprit.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit: схема, сериализация.

## Требования к документации

- docs/architecture/modules.md §4.
