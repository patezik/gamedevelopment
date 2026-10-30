---
id: PHONE-001
title: "Домен телефона: PhoneState, редьюсер событий, проекция PhoneView"
status: todo
priority: P0
complexity: L
phase: 5
milestone: M5
area: phone
depends_on: [INV-001, PROTO-002]
modules: ["packages/core/src/phone"]
assignee: null
claimed_at: null
---

# PHONE-001 — Домен телефона: PhoneState, редьюсер событий, проекция PhoneView

## Описание

Содержимое телефона — часть игрового состояния (modules.md §11).

## Цель

Все игровые события, касающиеся телефона, отражаются в соответствующих приложениях.

## Scope

- PhoneState: контакты, переписки, журнал звонков, активный звонок, галерея, файлы (скрытые/зашифрованные), заметки, метки карты, страницы браузера, уведомления, заряд.
- reducePhone(state, domainEvent).
- projectPhoneView без полей истины (hallucination скрыт).
- Начальное состояние телефона героя из пресета.

## Out of Scope

- Действия телефона (ENG-004).
- Галлюцинации (SURV-005).

## Зависимости

- [INV-001](INV-001.md) — PlayerKnowledge: найденные улики, услышанные показания, контакты, журнал
- [PROTO-002](PROTO-002.md) — Схемы PlayerView и PhoneView с фикстурами

## Затрагиваемые модули

- `packages/core/src/phone`

## Ожидаемый результат

Домен телефона.

## Критерии приёмки

- [ ] Проекция проходит схему PhoneView.
- [ ] Тест утечек как в ENG-002.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit по событиям.

## Требования к документации

- docs/architecture/modules.md §11.
