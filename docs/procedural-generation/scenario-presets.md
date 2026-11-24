# Формат сценариев-пресетов

Пресет — **шаблон**, а не сюжет. Он задаёт мир, правила и ограничения, но не виновника и не
список подозреваемых. Схема — zod в `@hs/core/content` (задача CNT-001); данные — JSON.

## 1. Структура каталога

```
content/scenarios/<scenarioId>/
├── preset.json          — метаданные, время, концовки, условия победы/поражения, квоты
├── locations.json       — локации, связи, доступ, освещение, точки интереса
├── items.json           — предметы и места появления
├── archetypes.json      — архетипы персонажей: распределения личности, рутины, доступы, пулы биографий
├── relationships.json   — шаблоны отношений и секретов
├── motives.json         — правила мотивов
├── crimes.json          — шаблоны инцидентов: требования, план действий, окна
├── trace-rules.json     — правила следов по глаголам
├── deduction-rules.json — правила установления утверждений
├── text/ru/*.json       — текстовые шаблоны (показания, документы, сообщения, описания)
└── phone/*.json         — шаблоны контента телефона (браузер, файлы, сообщения)
```

Девять файлов в корне пресета обязательны. `preset.json` содержит объект, остальные корневые
файлы содержат массивы. Примеры в разделах 3–5 показывают по одному элементу этих массивов.
Каталоги `text` и `phone` можно опустить. В репозитории сценариев имя папки совпадает с
`preset.id`. Загрузчик отдаёт ошибки с путём к значению, например `locations[0].connections[0].to`.

## 2. `preset.json` (сокращённо)

```json
{
  "id": "sanatorium_winter",
  "version": 1,
  "title": { "ru": "Санаторий «Сосновый бор»" },
  "time": { "startDateTime": "2026-01-14T08:00:00", "durationMinutes": 4320, "historyStartMinutes": -1440 },
  "cast": { "min": 7, "max": 7, "quotas": [ { "archetype": "head_doctor", "min": 1, "max": 1 }, { "archetype": "guest", "min": 3, "max": 4 } ] },
  "incident": { "types": ["murder"], "templates": ["poisoning", "staged_fall", "boiler_accident"], "minMotive": 0.4, "victimConstraints": { "excludeArchetypes": [] } },
  "criticalEvents": [ { "id": "blackout", "at": 2760, "earlierIf": { "staticAtLeast": 50, "at": 2400 } } ],
  "deadlines": [ { "id": "police_arrival", "at": 4320, "outcome": "time_up" } ],
  "endings": ["solved", "partial", "wrong_accusation", "time_up", "death", "madness"],
  "survival": { "startVitals": { "health": 10, "sanity": 8, "fatigue": 10 }, "staticCurve": "default" },
  "phone": { "minQrShare": 0.3 }
}
```

`incident.minMotive` — порог силы мотива для ConflictGen и IncidentSelection. Необязательное
`incident.gamma` (от 0 до 4, по умолчанию 0,7) — показатель `score^γ` при выборе виновника
([generation-pipeline.md §3](generation-pipeline.md#3-выбор-виновника-incidentselection)):
0 — равновероятно среди допустимых, больше 1 — сильнее в пользу лучшего `score`.
`victimConstraints.excludeArchetypes` исключает архетипы из жертв, но не из виновников.

## 3. Правило мотива (`motives.json`)

```json
{
  "id": "inheritance",
  "when": { "relation": { "type": "relative", "from": "$c", "to": "$v" }, "secret": { "kind": "will_changed", "about": "$v", "knownBy": "$c" } },
  "strength": { "base": 0.5, "plus": [ { "if": { "trait": "$c.honesty", "lt": 0.4 }, "add": 0.2 } ] },
  "evidenceHints": ["will_document", "lawyer_letter"]
}
```

## 4. Шаблон преступления (`crimes.json`)

```json
{
  "id": "poisoning",
  "incidentType": "murder",
  "requires": { "means": { "itemTag": "poison" }, "minWindowMinutes": 20, "locationTags": ["private", "medical"], "traits": {} },
  "plan": [
    { "step": "acquire", "verb": "take", "target": "$means", "before": "act" },
    { "step": "act", "verb": "poison", "target": "$victim", "duration": 10 },
    { "step": "conceal", "verb": "hide", "target": "$means", "after": "act", "optional": false }
  ],
  "deathDelayMinutes": [60, 180]
}
```

Шаблон участвует в генерации, если его `id` есть в `preset.incident.templates`, а
`incidentType` — в `preset.incident.types`. IncidentSelection читает поля так:

- `requires.means` — любой предмет с тегом `itemTag`; при `itemId` — только этот предмет с этим тегом;
- `requires.locationTags` — место преступления несёт **все** перечисленные теги; пустой список —
  любая локация;
- `requires.traits` — `{ "<черта личности>": { "gt"?: x, "lt"?: x } }`, границы строгие, от 0
  до 1, нужна хотя бы одна; другой формат, неизвестная черта или пустой диапазон — `RangeError`;
- `requires.minWindowMinutes` — длина окна без свидетелей;
- `plan` — шаг с `target: "$victim"` требует жертву на месте всё окно; без такого шага, но с
  `deathDelayMinutes`, жертва должна оказаться на месте через `[min, max]` минут после окна.
  Порядок и длительность шагов использует PlotPlanning (GEN-007).

## 5. Правило следа (`trace-rules.json`)

```json
{ "verb": "take", "when": { "targetTag": "poison" }, "produces": [
  { "kind": "physical", "at": "$location", "template": "missing_vial", "supports": ["means($actor)"], "captureMode": "qr", "decaysAfter": null },
  { "kind": "document", "at": "loc_doctor_office", "template": "inventory_log_gap", "supports": ["presence($actor,$location,$t)"], "requires": { "itemId": "it_inventory_log" } }
] }
```

Правила интерпретирует `@hs/core/evidence` (`compileTraceRules`, `tracesForEvent`, `deriveTraces`);
решения — [ADR 0017](../architecture/adr/0017-trace-conservation-and-payload.md).

- Правило срабатывает на событие истины, если `verb` совпадает с глаголом события и хотя бы одна
  цель события вида `item` удовлетворяет **всем** условиям `when` одновременно: `itemId` — id
  предмета, `targetTag` — тег предмета из `items.json`. Правило без `when` (или с пустым `when`)
  срабатывает на каждое событие своего глагола. Цели других видов (`location`, `document`,
  `character`) условиям `when` не удовлетворяют.
- Правило срабатывает не более одного раза на событие; каждый элемент `produces` даёт не более
  одного следа. Сработали несколько правил — следы всех правил, в порядке правил в файле и
  элементов `produces`.
- `verb` правила имеет тот же формат, что глагол события `TruthLog` (`verbSchema` из
  `@hs/core/common`: `^[a-z][a-z0-9_]*$`, например `take_item`; `take-item` недопустим).
- `at` — id локации или `$location` (локация события); список подстановок —
  `TRACE_LOCATION_PLACEHOLDERS`. Другие подстановки в `at` и недопустимый `verb` отклоняет одна и
  та же схема `traceRulesSchema`: при загрузке сценария — `CONTENT_SCHEMA_ERROR`, в
  `compileTraceRules` — `EVIDENCE_RULE_INVALID`.
- **Закон сохранения улик.** Для каждого глагола сокрытия — `hide`, `destroy`, `stage`
  (`CONCEALMENT_VERBS`) — в наборе обязательно правило без условий `when`, у которого хотя бы один
  элемент `produces` без `requires`. Иначе `compileTraceRules` бросает `EVIDENCE_RULE_INVALID`
  (путь `traceRules`). Загрузчик контента этот закон не проверяет.
- Полезная нагрузка следа: `template` — из правила; `captureMode` — `qr` или `auto` (`direct` и
  отсутствие поля); `supports` — строки правила с подстановкой `$location` (локация события),
  `$t` (начало события) и `$actor` (строка повторяется для каждого различного участника, без
  участников — отбрасывается), без дубликатов. Другие `$`-подстановки в `supports` отклоняет
  `compileTraceRules`.
- `itemId` следа — носитель: `requires.itemId`, иначе первая цель-предмет, удовлетворившая `when`
  (для правила без условий — первая цель-предмет события). След с `requires` не порождается, если
  носителя нет в мире (`ItemRegistry`) или он уничтожен к `availableFrom`.
- Уничтожение: событие `destroy` уничтожает свою первую цель-предмет в момент `t + duration`;
  учитывается только первое уничтожение предмета. След с этим `itemId` получает `destroyedBy`
  (id события) и `destroyedAt`, если `availableFrom < destroyedAt < decaysAt`. Следы самого
  `destroy` начинаются в момент уничтожения и им не уничтожаются. `tracesForEvent` учитывает
  уничтожение, только если передан журнал истины четвёртым аргументом.
- `tracesForEvent` и `deriveTraces` принимают только `TraceRuleSet` из `compileTraceRules`
  (глубоко заморожен; объект `{ rules }` той же формы отклоняется типами и `EVIDENCE_RULE_INVALID`).
- `sourceEventId` следа — id события. Id следа — `tr_` + 16 hex-символов хеша от
  `(sourceEventId, номер правила, номер элемента produces)`: стабилен между запусками и не раскрывает
  порядок событий. Перестановка правил в файле меняет id следов.
- `availableFrom = t + duration` события (следствие доступно после завершения причины, инвариант 3
  [truth-model.md](../investigation/truth-model.md)); `decaysAt = availableFrom + decaysAfter`, если
  `decaysAfter` — число (`> 0`); `null` или отсутствие поля — след не исчезает. След существует на
  полуинтервале `[availableFrom, min(decaysAt, destroyedAt))` — `isTraceAvailable(trace, t)`.
  Время может быть отрицательным (предыстория). Если `availableFrom`, `decaysAt` или `destroyedAt`
  выходит за диапазон безопасных целых чисел, вычисление прерывается `RangeError` с id события
  (кода домена для времени события нет), частичный результат не возвращается.
- Журнал истины не изменяется: `TruthEvent.traceIds` движок следов не заполняет.

## 6. Локации, предметы и персонажи

`preset.world` может задать `startLocationId` и список `variants`. По seed выбирается один
вариант целиком. Поле `doors` переопределяет замок существующего направленного ребра
по `from` и `to`. Значение `locked: null` открывает ребро. Поле `spawns` заменяет начальное
размещение предмета по `itemId`. В `placement` указываются `kind` (`location`, `container`
или `archetype`) и `id` соответствующей записи. Без `world` используются исходные локации
и предметы, стартом служит первая локация.

| Файл | Поля записи |
|------|-------------|
| `locations.json` | `id`, `name`, `description`, `tags`, `lighting`, `access`, `hotspots`, `connections` |
| `items.json` | `id`, `name`, `kind`, `tags` и при необходимости ссылки `locationId`, `containerId`, `ownerArchetype` |
| `archetypes.json` | `id`, `title`, `names`, `personality`, `routine`, `access`, `biography` |
| `relationships.json` | `id`, `type` и необязательные `fromArchetypes`, `toArchetypes`, `constraints`, `secrets` |
| `deduction-rules.json` | `id`, `establishes`, `requires` и необязательный `excludes`. Утверждения записываются строками |

У `lighting` четыре ключа `morning`, `day`, `evening`, `night` со значениями `bright`, `dim`
или `dark`. Связь содержит `to` и `minutes`. У замка `locked` можно указать ключ `itemId`.
Правило доступа может содержать `from`, `to` в минутах суток, `archetypes` и `itemId`.
Точка интереса содержит `id`, `name`, `description` и необязательный `itemIds`.

Имена в `archetypes.json` записываются в порядке «имя, отчество (если есть), фамилия».
Допустимо одно имя без фамилии. CastGen сравнивает первые и последние слова без учёта регистра,
чтобы имя и фамилия встречались в составе не более одного раза. Фрагмент биографии может
указать `excludes` со списком тегов, с которыми он несовместим. Исключения проверяются в обе
стороны при подборе до трёх фрагментов.

Свойство личности задаётся диапазоном `[min, max]` от 0 до 1. Элемент `routine` содержит
`from`, `to`, `locationId` и `activity`. Элемент `access` может ссылаться на `locationId`
или `itemId`, а элемент `biography` содержит `text` и `tags`. Каждый секрет в шаблоне
отношений содержит `kind` и `template`.

### `relationships.json` и стадия SocialGen

Шаблон описывает отношение `fromArchetypes → toArchetypes` типа `type`. Тип — значение
`RelationType` (`parent`, `child`, `sibling`, `spouse`, `romance`, `friendship`, `rivalry`,
`debt`, `employment`, `blackmail`, `past_conflict`); другой тип SocialGen отклоняет ошибкой.
Отсутствующий список архетипов разрешает любой архетип. Порядок шаблонов, их секретов и
персонажей на результат не влияет: SocialGen сортирует их по идентификаторам.

Необязательные `constraints` поддерживают три ключа — целые числа ≥ 0; другие ключи дают ошибку:

| Ключ | Смысл |
|------|-------|
| `maxCount` | не больше стольких отношений по шаблону в составе |
| `minAgeGap`, `maxAgeGap` | границы разницы возрастов `from − to` в годах |

Правила, которые действуют всегда:

- у персонажа не больше одного супруга (`spouse`); у ребёнка не больше двух родителей;
- родитель старше ребёнка на 16–60 лет, разница возрастов братьев и сестёр — не больше 25 лет;
- пара связана не более чем одним родственным или любовным отношением (`parent`/`child`,
  `sibling`, `spouse`, `romance`), а одно отношение одного типа (с учётом обратного) — одно;
- родство начинается с рождения младшего (`since` = `historyStartMinutes − age · 525 600`),
  остальные отношения — когда обоим уже есть 18 лет, в пределах типичной для типа давности.

У каждого персонажа ≥ 2 разных партнёра по отношениям, и он — субъект (`about`) ≥ 1 секрета.
Секрет берётся из `secrets` шаблона отношения, в котором участвует субъект; вид секрета у одного
субъекта не повторяется. Исходно секрет знают субъект и второй участник этого отношения. Схема
не указывает, о какой стороне отношения секрет, поэтому субъект выбирается случайно, а для
обязательного секрета — тот персонаж, которому секрет нужен. Если шаблоны не позволяют выполнить
минимумы, SocialGen выбрасывает `RangeError`; невозможные отношения не создаются.

Результат стадии — `SocialWorld`:

- `characters` — входные персонажи в исходном порядке; `secrets` — идентификаторы секретов о них;
- `relationships` — `RelationshipGraph`, все отношения значимые (`intensity ≥ 0,4`);
- `secrets` — `SocialSecret`: поля `Secret` (`id` вида `sec_N`, `fact`, `knownBy`) и метаданные
  `kind`, `template`, `about`, `origin` (шаблон и отношение), нужные ConflictGen;
- `history` — события предыстории `ev_1…ev_N` до `historyStartMinutes` в порядке времени.
  Отношение — событие `form_relationship` с фактом `relation` (`since`), его `id` записан в
  `Relationship.history`. Секрет — событие `keep_secret` (`covert`) с фактом
  `state(character, property = kind, value = true)` на интервале от начала секрета до
  `historyStartMinutes`. Эти события создают `TruthModel`: `new TruthModel(incident, history)`.

У событий предыстории нет акторов и фактов `at`, поэтому они не утверждают, где был персонаж.
`TruthEvent.location` обязан ссылаться на локацию мира, и SocialGen указывает стартовую локацию
пресета. Ограничение MVP: CastGen задаёт всем персонажам возраст 45, поэтому шаблон
`rel_family_parent` в санатории не срабатывает, а `rel_family_siblings` даёт ровесников.

## 7. Тексты и телефон

В `text/<locale>/<file>.json` каждый ключ шаблона связан с непустым массивом строк.
Каждый `phone/<file>.json` содержит массив записей с `id`, `kind` и строкой `template`.
Допустимые виды — `message`, `page`, `file`, `wallpaper`. Поля `title`, `event`, `hidden`
и `password` необязательны. Минимальные примеры всех файлов лежат в
[`_test_minimal`](../../content/scenarios/_test_minimal).

## 8. Правила для авторов

1. Никогда не называйте виновника и не создавайте роль «подозреваемый».
2. Каждый глагол, используемый в `crimes.json`, должен иметь правило следа (иначе ошибка загрузки).
3. Каждое сокрытие (`hide`, `destroy`, `stage`) должно производить вторичный след.
4. Проверьте структуру и ссылки через `npm run content:check`. Проверка запускается в CI.
5. После появления seed sweep проверьте генерацию через `npm run sweep -- --scenario <id> --count 1000`
   по критериям из [validation.md](../investigation/validation.md).
