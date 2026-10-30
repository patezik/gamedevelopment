---
id: SURV-005
title: "Галлюцинации на телефоне и проверка V-HALLUCINATION"
status: todo
priority: P1
complexity: M
phase: 7
milestone: M7
area: survival
depends_on: [SURV-002, PHONE-001, VAL-001]
modules: ["packages/core/src/survival/hallucinations.ts", "packages/validator/src/checks/hallucination.ts"]
assignee: null
claimed_at: null
---

# SURV-005 — Галлюцинации на телефоне и проверка V-HALLUCINATION

## Описание

Психологические эффекты без нечестности (survival-horror.md §5).

## Цель

Галлюцинации пугают, но не ломают логику расследования.

## Scope

- Генерация галлюцинаторных сообщений/фото/звонков по рассудку и Static (флаг hallucination на сервере).
- Исчезновение после отдыха.
- Запрет прикладывать к делу (INV-005 уже отклоняет).
- V-HALLUCINATION.

## Out of Scope

- Визуальные эффекты (MOB-011).

## Зависимости

- [SURV-002](SURV-002.md) — Static: глобальная эскалация, пороги, влияние на события сценария
- [PHONE-001](PHONE-001.md) — Домен телефона: PhoneState, редьюсер событий, проекция PhoneView
- [VAL-001](VAL-001.md) — Каркас валидатора и проверки V-TRUTH-INV, V-TIMELINE

## Затрагиваемые модули

- `packages/core/src/survival/hallucinations.ts`
- `packages/validator/src/checks/hallucination.ts`

## Ожидаемый результат

Галлюцинации.

## Критерии приёмки

- [ ] Галлюцинация не ссылается на факты решения (проверка).
- [ ] Флаг не утекает в PhoneView (тест утечек).
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + проверка валидатора.

## Требования к документации

- docs/game-design/survival-horror.md §5.
