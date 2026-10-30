# Architecture Decision Records (ADR)

ADR фиксирует значимое архитектурное решение: контекст, рассмотренные варианты, выбор и последствия.
Любое решение, которое меняет границы модулей, протокол, стек, формат данных или процесс, оформляется новым ADR.

## Правила

- Файл: `NNNN-kebab-case-title.md`, номер — следующий свободный.
- Статусы: `Proposed` → `Accepted` → (`Superseded by NNNN` | `Deprecated`).
- Принятый ADR не переписывается. Чтобы изменить решение, создайте новый ADR и пометьте старый как `Superseded`.
- ADR со статусом `Proposed` требует подтверждения владельца проекта, если он касается пунктов из [open-questions.md](../../planning/open-questions.md).
- Шаблон: [template.md](template.md).

## Реестр

| № | Решение | Статус |
|---|---------|--------|
| [0001](0001-monorepo-structure.md) | Монорепозиторий: npm workspaces + Godot-проект | Accepted |
| [0002](0002-headless-game-core.md) | Авторитетное headless Game Core на TypeScript, Godot — клиент представления | Accepted (подтверждено владельцем, OQ-01 закрыт) |
| [0003](0003-backend-stack.md) | Backend: Node.js 24 LTS + Fastify 5 + ws, модульный монолит, локальный хостинг | Accepted |
| [0004](0004-determinism.md) | Детерминизм: seed-подпотоки PRNG, целочисленное время, запрет недетерминированных API | Accepted |
| [0005](0005-truth-and-knowledge.md) | Truth Model как журнал событий; знания персонажей — отдельные хранилища убеждений | Accepted |
| [0006](0006-generation-pipeline.md) | Генерация «сначала мир — потом виновник» + валидатор как обязательный шлюз | Accepted |
| [0007](0007-mobile-stack.md) | Мобильный стек: Expo SDK 58, Expo Router, Zustand, Expo Go-first | Accepted |
| [0008](0008-pairing-and-security.md) | Привязка устройства и безопасность сессии | Accepted |
| [0009](0009-protocol-schemas.md) | Протокол: zod — источник схем, экспорт JSON Schema для Godot, полные снимки представлений | Accepted |
| [0010](0010-qr-rendering-on-server.md) | QR-коды генерирует сервер (матрица), Godot только рисует | Accepted |
| [0011](0011-godot-client-stack.md) | Godot 4.7.2, GDScript со строгой типизацией, GUT 9.7.x | Accepted |
| [0012](0012-task-management-in-repo.md) | Задачи — Markdown-файлы с frontmatter в репозитории | Accepted |
| [0013](0013-simulation-lod.md) | Событийная симуляция персонажей с уровнями детализации | Accepted |
| [0014](0014-save-system.md) | Сохранения: seed + версия генератора + журнал действий + контрольный хеш | Accepted |
