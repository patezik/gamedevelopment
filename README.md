# Hollow Signal

Детективный survival horror roguelike с процедурно генерируемыми расследованиями, автономными
персонажами и реальным смартфоном игрока в роли телефона героя.

> Рабочее название. Статус: **фаза 1 — Foundation**. Кода игры пока нет: репозиторий содержит
> архитектуру, спецификации, задачи и инструменты координации разработки.

## Компоненты

| Компонент | Путь | Технологии |
|-----------|------|-----------|
| Desktop-клиент | `apps/desktop` | Godot 4.7.2, GDScript, GUT |
| Companion-приложение | `apps/mobile` | React Native, Expo SDK 58, TypeScript, Expo Router, Zustand |
| Session Server | `apps/server` | Node.js 24 LTS, Fastify 5, ws |
| Game Core | `packages/core` | TypeScript (headless, детерминированное ядро) |
| Генератор / валидатор | `packages/generator`, `packages/validator` | TypeScript |
| Протокол | `packages/protocol` | zod 4, JSON Schema |
| Данные сценариев | `content/scenarios` | JSON |

Каталоги приложений и пакетов создаются задачами фазы Foundation (FND-001…FND-010).

## С чего начать

- **AI-агентам и разработчикам:** [AGENTS.md](AGENTS.md).
- **Документация:** [docs/README.md](docs/README.md).
- **Задачи:** [tasks/INDEX.md](tasks/INDEX.md) · `npm run tasks:ready`.
- **Roadmap и MVP:** [docs/planning/roadmap.md](docs/planning/roadmap.md) · [docs/planning/mvp.md](docs/planning/mvp.md).

## Быстрые команды

```bash
npm run tasks:ready     # задачи, готовые к взятию
npm run tasks:check     # проверка задач
npm run docs:check      # проверка ссылок документации
```

## Лицензия

Не определена — см. [open-questions.md](docs/planning/open-questions.md) (OQ-02).
