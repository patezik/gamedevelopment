# Truth Model — объективная истина расследования

Решение — [ADR 0005](../architecture/adr/0005-truth-and-knowledge.md). Интерфейс — [modules.md §5](../architecture/modules.md).

## 1. Назначение

Truth Model отвечает на вопросы: **что произошло, кто участвовал, кто ответственен, почему,
когда, где, какие действия совершались и какие следы они оставили.** Все остальные системы
(улики, показания, документы, сообщения, хронология, поведение NPC) порождаются из неё или
дописывают в неё новые события. Ни одна система не «придумывает» факт мимо Truth Model.

## 2. Состав

```
TruthModel
├── TruthLog: TruthEvent[]          — append-only, упорядочен по (t, id)
├── IncidentRecord                  — тип, жертвы, culpritIds, мотив, средство, ключевые события, окно
├── SecretRegistry                  — секреты: факт + кто знает (начальное состояние знаний)
└── индексы: presence по персонажам, possession по предметам, facts по kind
```

### TruthEvent

| Поле | Смысл |
|------|-------|
| `id` | `ev_<n>`, порядковый номер |
| `t`, `duration` | начало и длительность в игровых минутах |
| `verb` | из словаря: `move`, `stay`, `talk`, `take`, `give`, `hide`, `destroy`, `poison`, `strike`, `stage`, `write`, `read`, `call`, `message`, `lock`, `unlock`, `observe`, `sleep`, `work`, … |
| `actorIds` | кто совершил |
| `location` | где |
| `targets` | на что/кого направлено (`EntityRef`: персонаж, предмет, документ, локация) |
| `causes` | события-причины (план виновника, реакция на событие) |
| `facts` | факты, ставшие истинными в результате (см. ниже) |
| `traceIds` | порождённые следы (заполняет Evidence System) |
| `visibility` | `public` (видно присутствующим), `covert` (скрытно — увидеть может только внимательный свидетель), `private` (без свидетелей по определению) |

### Словарь фактов (`Fact`)

```ts
type Fact =
  | { kind: "at"; who: CharacterId; where: LocationId; interval: Interval }
  | { kind: "did"; who: CharacterId; verb: Verb; target?: EntityRef; at: GameMinutes; where: LocationId }
  | { kind: "possessed"; who: CharacterId; item: ItemId; interval: Interval }
  | { kind: "relation"; a: CharacterId; b: CharacterId; relType: RelationType; since?: GameMinutes }
  | { kind: "motive"; who: CharacterId; against: CharacterId; motiveType: MotiveType; basis: FactId[] }
  | { kind: "state"; entity: EntityRef; property: string; value: string | number | boolean; interval: Interval };
```

Факты — **пропозиции**, которыми оперируют знания персонажей (`Belief.proposition`), показания
(`Statement.proposition`) и утверждения расследования (`Claim`). Единый словарь — основа
согласованности.

## 3. Время жизни

1. **Генерация** (стадии PlotPlanning, HistorySimulation) создаёт предысторию до `t = 0` (отрицательные
   времена допустимы для предыстории: `t < 0`) и `IncidentRecord`.
2. **Игра:** симуляция NPC и действия игрока дописывают события с `t ≥ 0`. Действия игрока тоже
   являются событиями истины (актор `player`) — NPC могут их наблюдать.
3. **Финал:** после завершения игры клиенту может быть показан «разбор» — проекция `IncidentRecord`
   и ключевых событий (`TruthRecap`), это единственный легальный выход истины к клиенту.

## 4. Инварианты (проверяются `checkTruthInvariants`)

1. Персонаж в каждый момент в одной локации или «в пути» (нет пересекающихся интервалов `at`).
2. Перемещение между локациями не быстрее времени из графа.
3. Причина раньше следствия (`causes[i].t + causes[i].duration ≤ e.t`).
4. Предмет в каждый момент у одного владельца/в одном месте.
5. Мёртвый персонаж не совершает действий после времени смерти.
6. Событие с `visibility: public` фиксирует наблюдения всех присутствующих (иначе — ошибка
   симуляции знаний).
7. Каждое `IncidentRecord.keyEventIds` существует, и среди его акторов есть хотя бы один `culpritId`.

## 5. Связь с другими системами

| Система | Как использует истину |
|---------|-----------------------|
| Character Simulation | пишет события; формирует наблюдения присутствующих |
| Knowledge | начальные знания из `SecretRegistry`; наблюдения → убеждения |
| Evidence | `TraceRule` по `verb` → следы → улики со ссылкой `sourceEventId` |
| Investigation | **только** `evaluateAccusation` читает `IncidentRecord` |
| Validator | полный доступ: решаемость, инварианты, ложь |
| Phone | сообщения NPC — следствие событий `message` / `call` в истине |

## 6. Debug-доступ

При `HS_DEBUG_TRUTH=1` сервер отдаёт `GET /api/v1/sessions/:id/debug/truth` (только с
`desktopToken`) — полный журнал. Используется в разработке и при разборе багов; в релизных сборках
флаг игнорируется.
