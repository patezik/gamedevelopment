# AGENTS.md — руководство для AI-агентов и разработчиков

Этот документ — обязательная точка входа для любого контрибьютора, человека или AI-агента.
Прочитайте его целиком перед первой задачей. Репозиторий — **единственный источник истины**:
код, документация, решения (ADR) и задачи живут здесь.

## 1. Что это за проект

**Hollow Signal** (рабочее название) — детективный survival horror roguelike:

- каждое прохождение — процедурно сгенерированное, логически непротиворечивое расследование;
- виновником может стать **любой** подходящий персонаж; списка подозреваемых нет;
- персонажи — автономные агенты с собственными знаниями, ложью и расписаниями;
- время — главный ресурс: каждое действие стоит игровых минут;
- **реальный смартфон игрока** — телефон героя (companion-приложение на Expo с виртуальной ОС;
  камера фиксирует игровые QR-улики с экрана компьютера).

Компоненты: Godot 4.7 desktop-клиент (`apps/desktop`), Expo-приложение (`apps/mobile`),
Node.js Session Server (`apps/server`), headless Game Core и генератор на TypeScript (`packages/*`).
Обзор — [docs/architecture/overview.md](docs/architecture/overview.md).

## 2. Порядок изучения (≈ 30–40 минут)

Обязательно, по порядку:

1. [docs/vision/vision.md](docs/vision/vision.md) — что и зачем мы делаем.
2. [docs/architecture/overview.md](docs/architecture/overview.md) — компоненты и потоки данных.
3. [docs/architecture/adr/README.md](docs/architecture/adr/README.md) — принятые решения (прочитайте 0002, 0004, 0005).
4. [docs/architecture/modules.md](docs/architecture/modules.md) — границы модулей и интерфейсы.
5. [docs/development/coding-standards.md](docs/development/coding-standards.md) и [git-workflow.md](docs/development/git-workflow.md).
6. [docs/planning/roadmap.md](docs/planning/roadmap.md) и [tasks/INDEX.md](tasks/INDEX.md).

Затем — документы своей области:

| Область задачи (`area`) | Читать |
|-------------------------|--------|
| core, time, world, characters, truth, knowledge, engine | [truth-model.md](docs/investigation/truth-model.md), [time-system.md](docs/simulation/time-system.md) |
| simulation | [character-simulation.md](docs/simulation/character-simulation.md), ADR 0013 |
| generator, content | [generation-pipeline.md](docs/procedural-generation/generation-pipeline.md), [scenario-presets.md](docs/procedural-generation/scenario-presets.md), [mvp-scenario-sanatorium.md](docs/game-design/mvp-scenario-sanatorium.md) |
| evidence, investigation, validator | [investigation-model.md](docs/investigation/investigation-model.md), [validation.md](docs/investigation/validation.md) |
| protocol, server, tools | [backend.md](docs/backend/backend.md), [protocol.md](docs/backend/protocol.md), ADR 0008, 0009 |
| mobile, phone | [mobile-app.md](docs/mobile/mobile-app.md), [qr-mechanics.md](docs/mobile/qr-mechanics.md), ADR 0007 |
| desktop | [godot-client.md](docs/desktop/godot-client.md), ADR 0011 |
| survival | [survival-horror.md](docs/game-design/survival-horror.md) |
| любая | [game-design.md](docs/game-design/game-design.md), [testing-strategy.md](docs/testing/testing-strategy.md), [glossary.md](docs/glossary.md) |

## 3. Непреложные правила

1. **Истина не покидает сервер.** Клиенты получают только `PlayerView` / `PhoneView`. Никаких полей
   `culpritIds`, `veracity`, `truth`, `hallucination` в представлениях.
2. **Нет роли «подозреваемый».** Character ≠ Culprit ≠ Suspect ([investigation-model.md §1](docs/investigation/investigation-model.md)).
3. **Детерминизм.** В `packages/core|generator|validator` запрещены `Math.random`, `Date.now`,
   `new Date()`; случайность — только через `Rng` и подпотоки ([ADR 0004](docs/architecture/adr/0004-determinism.md)).
4. **Время двигает только `TimeSystem.advance`.** Никаких независимых таймеров в механиках.
5. **Правила игры — в Game Core**, не в Godot и не в мобильном приложении ([ADR 0002](docs/architecture/adr/0002-headless-game-core.md)).
6. **Мобильное приложение не читает реальные данные телефона** и запрашивает только камеру.
7. **Не добавляйте зависимость** без проверки совместимости, лицензии и записи в [tech-stack.md](docs/architecture/tech-stack.md).
8. **Не принимайте решения из [open-questions.md](docs/planning/open-questions.md)** самостоятельно — спросите владельца.
9. **Не отмечайте незавершённое как выполненное.** Если часть критериев приёмки не выполнена — задача остаётся `in_progress` или переводится в `blocked` с объяснением.

## 4. Выбор задачи

```bash
npm run tasks:ready                 # задачи, у которых все зависимости done
npm run tasks:ready -- --area mobile
node tools/tasks/tasks.mjs show CORE-001   # детали и статус зависимостей
```

Правила выбора:

1. Берите задачу только со статусом `todo`, у которой **все** `depends_on` имеют статус `done`.
2. Приоритет: `P0` → `P1` → `P2`; при равенстве — меньшая фаза; затем — задачи с критического пути
   ([tasks/INDEX.md](tasks/INDEX.md), раздел «Критический путь»).
3. Проверьте поле `modules`: если другая задача `in_progress` трогает те же файлы — выберите другую
   задачу или согласуйте порядок (одновременная правка одного файла — источник конфликтов).
4. Одна задача на агента одновременно.
5. Если задача кажется больше `L` или неясной — не начинайте её; создайте предложение по разбиению
   (раздел 10) или задайте вопрос.

## 5. Захват задачи (assign yourself)

Захват — атомарный push в `main` коммита, меняющего только файлы задачи ([ADR 0012](docs/architecture/adr/0012-task-management-in-repo.md)):

```bash
git checkout main && git pull --rebase
node tools/tasks/tasks.mjs claim CORE-001 --as <agent-name>   # status → in_progress, assignee, claimed_at
npm run tasks:index
git add tasks/ && git commit -m "claim(CORE-001): <agent-name>"
git push origin main
```

- Если `push` отклонён — `git pull --rebase` и **перепроверьте**, не захватил ли задачу кто-то другой
  (`node tools/tasks/tasks.mjs show CORE-001`). Если захватил — откатите свой коммит и выберите другую.
- `<agent-name>` — стабильное имя агента/сессии (например, `claude-core-1`).
- Захват старше 72 часов без активности (нет коммитов в ветке задачи) считается устаревшим:
  другой агент может переназначить задачу, указав причину в сообщении коммита.
- **Если `main` защищён от прямого push:** создайте ветку `claim/CORE-001`, PR с тем же изменением и
  меткой `claim`; захват действителен после merge.

## 6. Работа с Git

- Ветка: `task/<ID>-<короткое-описание-латиницей>`, например `task/CORE-001-sfc32-rng`.
- Одна задача — одна ветка — один PR. Не смешивайте задачи.
- Коммиты: [Conventional Commits](https://www.conventionalcommits.org/) с ID задачи:
  `feat(core): sfc32 PRNG with fork streams [CORE-001]`.
- Регулярно делайте `git rebase origin/main`; не переписывайте историю `main`.
- Подробно — [docs/development/git-workflow.md](docs/development/git-workflow.md).

## 7. Как писать код

- Следуйте [coding-standards.md](docs/development/coding-standards.md): TypeScript strict, GDScript со
  статической типизацией, английские идентификаторы, комментарии — по необходимости.
- Сначала тест или одновременно с кодом; критерии приёмки задачи — ваш чек-лист.
- Реализуйте только Scope задачи. Всё из Out of Scope — не трогать; найденные проблемы вне Scope —
  новые задачи (раздел 10).
- Интерфейсы из [modules.md](docs/architecture/modules.md) — контракт. Если его нужно изменить —
  обновите документ в том же PR и опишите изменение в PR. Изменение, затрагивающее другие модули
  или протокол, требует ADR.

## 8. Тесты и проверки

```bash
npm run lint && npm run typecheck && npm test   # TypeScript (после FND-001)
npm run test:godot                              # Godot (после FND-008, нужен GODOT_BIN)
npm test -w @hs/mobile                          # мобильное приложение (после FND-006)
npm run sweep -- --scenario sanatorium_winter --count 200   # генерация (после VAL-007)
npm run tasks:check                             # задачи и индекс
npm run docs:check                              # ссылки документации
```

Перед PR все проверки, относящиеся к затронутым областям, должны быть зелёными локально.
Стратегия — [testing-strategy.md](docs/testing/testing-strategy.md).

## 9. Документация

- Документация обновляется **в том же PR**, что и код (раздел «Требования к документации» задачи).
- Основной язык документов — русский; идентификаторы, API, имена классов — английский.
- Новое архитектурное решение — новый ADR по [шаблону](docs/architecture/adr/template.md).
- Не создавайте пустые файлы и разделы «на будущее».

## 10. Создание новых задач

Если вы нашли работу вне Scope (баг, недостающая функция, нужный рефакторинг):

1. Скопируйте любой файл из `tasks/` как образец, дайте следующий свободный ID своей области.
2. Заполните все разделы; `status: todo`, `assignee: null`; задача ≤ `L`.
3. Укажите зависимости в `depends_on` **и** в разделе «Зависимости».
4. `npm run tasks:index && npm run tasks:check`.
5. Новые задачи добавляются в вашем PR или отдельным PR `chore(tasks): ...`.

## 11. Pull Request и передача на проверку

1. Обновите `main`, сделайте rebase, прогоните проверки.
2. Отметьте выполненные пункты «Критерии приёмки» в файле задачи (`- [x]`).
3. Переведите задачу в `review`: `node tools/tasks/tasks.mjs status CORE-001 review && npm run tasks:index`.
4. Создайте PR в `main` по [шаблону](.github/pull_request_template.md): ID задачи в заголовке
   (`[CORE-001] sfc32 PRNG`), что сделано, как проверено, что не сделано, вопросы.
5. Ревьюер проверяет критерии приёмки, тесты, документацию, соблюдение правил раздела 3.
6. **Перед merge** ревьюер (или автор после одобрения) переводит задачу в `done` в той же ветке
   (`status CORE-001 done`, `tasks:index`). Merge — squash.
7. Если работа не завершена — PR не мержится, задача остаётся `in_progress`; если вы прекращаете
   работу — верните задачу в `todo` (`status CORE-001 todo`) с комментарием в PR о сделанном.

## 12. Блокировки и вопросы

- Задача не может быть выполнена из-за внешней причины → `status <ID> blocked`, причина в разделе
  «Описание» (добавьте абзац «Блокировка: …») и в PR/issue.
- Вопрос к владельцу → добавьте строку в [open-questions.md](docs/planning/open-questions.md).
- Противоречие в документации → исправьте, если очевидно; иначе — вопрос.

## 13. Чек-лист агента

- [ ] Прочитал обязательные документы раздела 2 и документы своей области.
- [ ] Задача `todo`, зависимости `done`, нет конфликта `modules`.
- [ ] Захватил задачу push-ом в `main`.
- [ ] Работаю в ветке `task/<ID>-...`, в рамках Scope.
- [ ] Тесты из «Требований к тестированию» написаны и проходят.
- [ ] Документация обновлена.
- [ ] Критерии приёмки отмечены честно.
- [ ] Статус `review`, PR создан по шаблону.
