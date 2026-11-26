# Git-процесс

## Ветки

| Ветка | Назначение |
|-------|-----------|
| `main` | всегда зелёная; защищена: merge только через PR, кроме коммитов захвата задач |
| `task/<ID>-<slug>` | работа над задачей, например `task/SRV-004-ws-gateway` |
| `claim/<ID>` | запасной вариант захвата задачи через PR (если прямой push запрещён) |

## Коммиты

Conventional Commits + ID задачи:

```
feat(server): websocket gateway with resume [SRV-004]
fix(core): scheduler ordering for equal priority [TIME-002]
docs(adr): 0015 save migration policy [QA-004]
chore(tasks): split GDT-008 into two tasks
claim(SRV-004): claude-server-2
```

Типы: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`, `claim`.

## Pull Request

- Заголовок: `[<ID>] Краткое описание`.
- Один PR — одна задача. Размер — до ~800 строк изменений без учёта сгенерированных файлов;
  больше — признак, что задачу нужно было разбить.
- Обязательные проверки CI: `tasks` (задачи и индекс), `docs` (ссылки), `node` (lint, typecheck,
  test с порогами покрытия; при изменениях TS-кода, контента и конфигов), `godot` (после FND-008,
  при изменениях Godot/протокола), `sweep` (после VAL-008, при изменениях генерации/контента).
- Merge — squash; сообщение squash-коммита — заголовок PR.
- Статус задачи переводится в `done` в ветке PR до merge (см. [AGENTS.md §11](../../AGENTS.md)).

## Конфликты

- `tasks/INDEX.md` генерируется автоматически после каждого merge в `main` (workflow `tasks-index.yml`). **Не добавляйте его в PR и не коммитьте** (ни в claim, ни в смену статуса); если он оказался в diff — `git checkout origin/main -- tasks/INDEX.md`. Локально посмотреть свежий индекс: `npm run tasks:index` (не коммитить).
- `package-lock.json` — `git checkout --theirs package-lock.json && npm install`.
- Сгенерированные схемы протокола и `protocol_constants.gd` — `npm run protocol:gen`.
