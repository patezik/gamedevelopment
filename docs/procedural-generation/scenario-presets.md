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

## 5. Правило следа (`trace-rules.json`)

```json
{ "verb": "take", "when": { "targetTag": "poison" }, "produces": [
  { "kind": "physical", "at": "$location", "template": "missing_vial", "supports": ["means($actor)"], "captureMode": "qr", "decaysAfter": null },
  { "kind": "document", "at": "loc_doctor_office", "template": "inventory_log_gap", "supports": ["presence($actor,$location,$t)"], "requires": { "itemId": "it_inventory_log" } }
] }
```

## 6. Локации, предметы и персонажи

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

Свойство личности задаётся диапазоном `[min, max]` от 0 до 1. Элемент `routine` содержит
`from`, `to`, `locationId` и `activity`. Элемент `access` может ссылаться на `locationId`
или `itemId`, а элемент `biography` содержит `text` и `tags`. Каждый секрет в шаблоне
отношений содержит `kind` и `template`.

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
