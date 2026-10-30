# Задачи

Каждая задача — файл `tasks/<ID>.md` ([ADR 0012](../docs/architecture/adr/0012-task-management-in-repo.md)).
Сводка, готовые к взятию задачи и критический путь — [INDEX.md](INDEX.md) (генерируется).
Процесс работы — [AGENTS.md](../AGENTS.md).

## Формат

```markdown
---
id: CORE-001                       # <ОБЛАСТЬ>-<NNN>, совпадает с именем файла
title: "Название"
status: todo                       # todo | in_progress | review | done | blocked | cancelled
priority: P0                       # P0 (блокирует MVP) … P3
complexity: M                      # S (≤ 0,5 дня агента) | M (≤ 1 дня) | L (≤ 2 дней); больше — разбить
phase: 2                           # 1..11, см. roadmap
milestone: M2                      # веха из docs/planning/roadmap.md, соответствует фазе
area: core                         # область (используется в tasks:ready --area)
depends_on: [FND-009]              # задачи, которые должны быть done
modules: ["packages/core/src/rng"] # затрагиваемые пути (для обнаружения конфликтов)
assignee: null                     # имя агента при in_progress/review
claimed_at: null                   # ISO-время захвата
---
```

Обязательные разделы тела: **Описание, Цель, Scope, Out of Scope, Зависимости, Затрагиваемые модули,
Ожидаемый результат, Критерии приёмки, Требования к тестированию, Требования к документации.**
Раздел «Зависимости» должен перечислять те же ID, что и `depends_on` (проверяется).

## Статусы

```
todo ──claim──▶ in_progress ──PR──▶ review ──merge──▶ done
  ▲                 │                  │
  └──── отказ ──────┘                  └── доработка ──▶ in_progress
blocked — внешняя причина (описать в задаче); cancelled — задача больше не нужна (с причиной)
```

## Области (`area`) и префиксы ID

| Префикс | area | Префикс | area |
|---------|------|---------|------|
| FND | foundation | GEN | generator |
| CORE | core | EVD | evidence |
| CNT | content | INV | investigation |
| TIME | time | VAL | validator |
| WORLD | world | PROTO | protocol |
| CHAR | characters | SRV | server |
| TRUTH | truth | TOOL | tools |
| KNOW | knowledge | PHONE | phone |
| SIM | simulation | MOB | mobile |
| ENG, SAVE | engine | GDT | desktop |
| SURV | survival | INT | integration |
| QA | qa | REL | release |
| PLAN | planning | | |

## Команды

```bash
npm run tasks:check                          # валидация (CI)
npm run tasks:ready                          # что можно взять
npm run tasks:index                          # обновить INDEX.md
node tools/tasks/tasks.mjs show <ID>
node tools/tasks/tasks.mjs claim <ID> --as <agent>
node tools/tasks/tasks.mjs status <ID> <status>
```
