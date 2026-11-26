# Модули: границы ответственности и интерфейсы

Для каждого модуля: **назначение, интерфейсы, вход/выход, зависимости, события, ошибки, тесты**.
Сигнатуры — целевые контракты; при реализации допускаются уточнения, но изменение семантики
оформляется обновлением этого документа в том же PR.

Общие типы (`@hs/core/common`):

```ts
type GameMinutes = number;            // целое; минуты от начала сценария (t = 0)
type CharacterId = string;            // "ch_<slug>", стабильный в пределах расследования
type LocationId = string;             // "loc_<slug>" из пресета
type ItemId = string;                 // "it_<slug>"
type EventId = string;                // "ev_<n>" — порядковый номер в TruthLog
type FactId = string;                 // "f_<hash16>"
type ClueId = string;                 // "cl_<hash12>"
interface Interval { from: GameMinutes; to: GameMinutes }   // полуинтервал [from, to)
```

`contains(interval, minute)` проверяет минуту с включённой нижней границей.
`overlaps(left, right)` проверяет непустое пересечение, а `intersect(left, right)` возвращает
пересечение или `null`. Соприкасающиеся и пустые интервалы не пересекаются.

`canonicalJson(value)` сохраняет порядок элементов массива и сортирует ключи объектов по кодовым
единицам UTF-16. Поддерживаются JSON-примитивы, плотные массивы и обычные объекты. Если значение
нельзя сериализовать, ошибка содержит путь к нему, например `$["events"][0]`.
`stateHash(value, hasher?)` возвращает SHA-256 от канонического JSON в виде 64 строчных
шестнадцатеричных символов. Реализация по умолчанию использует `node:crypto` через
`Hasher.sha256(text)`. `sequentialId(prefix)` создаёт отдельную последовательность `prefix_1`,
`prefix_2` и далее. `hashId(prefix, value, length)` добавляет к префиксу и подчёркиванию первые
`length` символов хеша (от 1 до 64).
`verbSchema` — формат глагола действия (`^[a-z][a-z0-9_]*$`), общий для событий `truth` (реэкспорт
из `@hs/core/truth`) и правил контента, которые с ними сопоставляются.

Зависимости между модулями ядра (стрелка = «использует»), циклы запрещены:

```
rng, common ← time ← world ← characters ← truth ← knowledge ← evidence ← investigation
                         ↖ simulation (time, world, characters, truth, knowledge, evidence)
survival (time, world) · phone (investigation, characters) · game (всё выше)
```

---

## 0. `@hs/core/content` — схемы и загрузка данных сценариев

- **Назначение:** zod-схемы всех файлов пресета ([scenario-presets.md](../procedural-generation/scenario-presets.md)),
  загрузка каталога сценария, перекрёстные проверки ссылок (id локаций, архетипов, глаголов).
- **Интерфейс:**
  ```ts
  interface ContentRepo { listScenarios(): ScenarioSummary[]; load(id: string): ScenarioContent }
  function loadScenarioFromDir(dir: string): ScenarioContent;   // fs только здесь; остальное ядро не трогает fs
  function crossCheck(c: ScenarioContent): ContentIssue[];
  ```
- **Ошибки:** `CONTENT_SCHEMA_ERROR` (путь к полю), `CONTENT_DANGLING_REF`, `CONTENT_MISSING_TRACE_RULE`.
- **Тесты:** все сценарии в `content/` проходят схему и перекрёстные проверки; намеренно сломанные
  фикстуры дают понятные ошибки.

## 1. `@hs/core/rng` — детерминированная случайность

- **Назначение:** PRNG `sfc32`, хеширование seed, подпотоки ([ADR 0004](adr/0004-determinism.md)).
- **Интерфейс:**
  ```ts
  interface RngState {
    readonly seed: string;
    readonly path: readonly string[];
    readonly words: readonly [number, number, number, number];
  }
  interface Rng {
    nextU32(): number; float(): number;                 // [0, 1)
    int(minIncl: number, maxIncl: number): number;
    chance(p: number): boolean;
    pick<T>(items: readonly T[]): T;
    weighted<T>(items: readonly { value: T; weight: number }[]): T;
    shuffle<T>(items: readonly T[]): T[];
    fork(label: string): Rng;                           // независимый подпоток
    readonly state: RngState;                           // сериализуемо
  }
  function createRng(seed: string): Rng;
  function restoreRng(state: RngState): Rng;
  ```
- **Вход/выход:** строковый seed → поток чисел. Начальное состояние вычисляется через `cyrb128`
  от JSON-массива `[seed, ...path]`, где `path` — метки вызовов `fork`. Первые 12 шагов
  [sfc32](https://github.com/bryc/code/blob/master/jshash/PRNGs.md#sfc32) прогревают состояние.
  `fork` зависит только от seed и пути, а `restoreRng` продолжает сохранённый поток с текущего
  состояния. **Зависимости:** нет.
- **Границы:** `int` включает обе границы и принимает безопасные целые. `shuffle` возвращает
  копию, в том числе для пустого массива.
- **Ошибки:** `RangeError` при неверных границах, вероятности вне `[0, 1]`, пустом списке для
  `pick` или `weighted`, неположительном или бесконечном весе, либо неверном состоянии.
- **Тесты:** golden-значения первых 10 чисел для фиксированных seed; независимость `fork`;
  восстановление из `state`; равномерность (χ², 10⁵ выборок).

## 2. `@hs/core/time` — TimeSystem, Calendar, Scheduler, стоимость действий

Подробно — [time-system.md](../simulation/time-system.md).

- **Интерфейс:**
  ```ts
  class Calendar { constructor(startIso: string); toDisplay(t: GameMinutes): { day: number; hh: number; mm: number; period: DayPeriod; dateIso: string }; format(t: GameMinutes): string }
  const TickPhase = { Calendar: 0, Schedules: 1, Simulation: 2, WorldEvents: 3, Availability: 4, Timers: 5, Outcome: 6 } as const  // + одноимённый union-тип; не enum: enum не поддерживается type stripping в Node
  interface ScheduledEvent<K extends string = string> { readonly id: string; readonly at: GameMinutes; readonly phase: TickPhase; readonly priority: number; readonly kind: K; readonly payload: unknown }
  class Scheduler {
    constructor(now?: GameMinutes);                 // по умолчанию 0; для предыстории — historyStartMinutes
    readonly now: GameMinutes; readonly size: number;
    schedule(e: Omit<ScheduledEvent, "id">): string;
    cancel(id: string): boolean;
    peek(): ScheduledEvent | undefined;
    popNext(until: GameMinutes): ScheduledEvent | undefined;   // одно ближайшее событие с at ≤ until
    popDue(t: GameMinutes): ScheduledEvent[];                  // все события с at ≤ t, затем now = t
    serialize(): SchedulerState;
    static restore(state: unknown): Scheduler;
  }
  type EventRequest = Omit<ScheduledEvent, 'id' | 'phase'>
  interface TickContext { readonly now: GameMinutes; schedule(event: EventRequest): string; cancel(id: string): boolean }
  interface PhaseHandler { readonly phase: TickPhase; handle(e: ScheduledEvent, ctx: TickContext): void | { interrupt: string } }
  class TimeSystem {
    constructor(calendar: Calendar, scenarioEnd: GameMinutes, start?: GameMinutes);
    now(): GameMinutes;
    advance(minutes: number, opts?: { interruptible: boolean }): AdvanceResult;
    registerHandler(kind: string, h: PhaseHandler): void;
    schedule(event: EventRequest): string;
    cancel(id: string): boolean;
  }
  interface AdvanceResult { from: GameMinutes; to: GameMinutes; processed: number; events: ClockEvent[]; interruptedAt?: GameMinutes; interruptReason?: string; limit?: 'TIME_BEYOND_SCENARIO_END' }
  function resolveActionCost(action: ActionKind, ctx?: CostContext, table?: ActionCostTable): ActionCost;  // table по умолчанию — DEFAULT_ACTION_COSTS
  function createActionCostTable(overrides?: unknown): ActionCostTable;  // дефолты + переопределения пресета
  interface ActionCost { min: number; max: number; expected: number }   // целые минуты
  interface CostModifier { id: string; order: number; apply(minutes: number, action: ActionKind, ctx: CostContext): number }
  interface TravelTimeProvider { travelTime(from: string, to: string): number | null }  // LocationGraph подходит структурно
  interface CostContext { travel?: { provider: TravelTimeProvider; from: string; to: string }; minutes?: number; conversationMinutes?: number; modifiers?: CostModifier[] }
  ```
- **Вход/выход:** стоимость действия в минутах → обработанные события и новое время.
- **Зависимости:** `rng` (только для вариативных стоимостей), `common`.
- **События (DomainEvent):** `ClockAdvanced`, `PeriodChanged`, `DayChanged`, `DeadlineReached`,
  `ScheduledEventMissed`.
- **Ошибки:** `TIME_NEGATIVE_ADVANCE`, `TIME_BEYOND_SCENARIO_END` (усекается до конца с исходом),
  `ACTION_INVALID` (неизвестное или неприменимое действие), `COST_TABLE_INVALID` (неверная таблица
  стоимостей пресета), `SCHEDULER_PAST_EVENT` (планирование в прошлое), `SCHEDULER_INVALID_STATE` (повреждённый снимок
  при `Scheduler.restore`).
- **Тесты:** порядок одновременных событий; переходы часов/дней/периодов; прерывания;
  сериализация/восстановление; сценарии разной длительности (property-тест).

## 3. `@hs/core/world` — локации, предметы, доступ

- **Назначение:** граф локаций (время перемещения, освещение по периодам, часы доступа, замки),
  предметы и контейнеры, их владельцы и положение во времени.
- **Интерфейс:**
  ```ts
  interface Location { id: LocationId; name: string; tags: string[]; lighting: Record<DayPeriod, Light>; access: AccessRule[]; hotspots: HotspotDef[] }
  interface Connection { from: LocationId; to: LocationId; minutes: number; locked?: LockDef }
  class LocationGraph {
    readonly accessItemIds: readonly ItemId[];
    travelTime(a, b, who?: Actor): number | null;
    path(a, b, who?: Actor): LocationId[];
    nextTimedStep(a, b, who: Actor, now: GameMinutes): TimedTravelStep | null;
    isAccessible(loc, who: Actor, t: GameMinutes): AccessCheck;
    lightingAt(loc, period: DayPeriod): Light;
  }
  interface Item { id: ItemId; kind: string; tags: readonly string[] }
  type ItemPlacement = { kind: "location"; id: LocationId }
    | { kind: "character"; id: CharacterId } | { kind: "container"; id: ItemId };
  interface ItemMove { t: GameMinutes; to: ItemPlacement; cause: EventId }
  class ItemRegistry {
    get(id: ItemId): Item;
    locate(id: ItemId, t: GameMinutes): ItemPlacement;
    move(id: ItemId, to: ItemPlacement, t: GameMinutes, cause: EventId): void;
    history(id: ItemId): readonly ItemMove[];
  }
  ```
- **Маршруты:** граф строится из загруженного пресета. Связи направленные. Маршрут включает обе
  конечные точки, а его стоимость — сумму минут переходов. При равенстве выбирается меньший
  идентификатор предшественника. Замок пропускает только носителя нужного ключа. Замок без
  указанного ключа закрыт, а при отсутствии актёра маршрут строится для пустого набора ключей.
- **Доступ к локации:** проверяется отдельно через `isAccessible` в заданную игровую минуту.
  Внутри правила должны выполняться все условия, из списка правил достаточно одного.
  Пустой список открывает доступ всем. Интервал включает начало и исключает конец, а при
  `from > to` пересекает полночь. При отказе возвращается причина из первого правила.
- **Вход по времени ([ADR 0015](adr/0015-time-aware-location-routing.md)):** `nextTimedStep` возвращает
  первое ребро маршрута с самым ранним прибытием с учётом доступа, в виде
  `{ destination, departAt, arriveAt, keyItemId? }`. Актёр может ждать открытия в предыдущей
  локации. Метод возвращает `null`, если он уже в цели или допустимого маршрута нет.
  `accessItemIds` перечисляет предметы из замков и условий входа. Для NPC набор
  `Actor.itemIds` формируется из реестра по [ADR 0016](adr/0016-physical-keys.md).
- **Нет маршрута:** `travelTime` возвращает `null`, `path` выдаёт `WORLD_NO_PATH`.
  Неизвестный идентификатор локации даёт `WORLD_UNKNOWN_LOCATION`.
- **Предметы:** реестр начинает работу с заданной игровой минуты (по умолчанию `0`). Для каждого
  предмета из контента требуется ровно одно начальное размещение. Выбор персонажа по `ownerArchetype`
  передаёт вызывающий код как соответствие архетипа и идентификатора персонажа. `locate` возвращает
  непосредственное положение, в том числе ссылку на контейнер, положение которого можно запросить
  на ту же минуту. `history` хранит только перемещения с указанием причины. Перемещения добавляются
  в хронологическом порядке, внутри одной минуты побеждает последнее принятое перемещение.
- **Зависимости:** `common`, `time` (периоды суток).
- **События:** `LocationAvailabilityChanged`, `ItemMoved`.
- **Ошибки:** `WORLD_UNKNOWN_LOCATION`, `WORLD_NO_PATH`, `WORLD_ACCESS_DENIED`.
- **Тесты:** кратчайший путь; доступ по часам и ключам; предмет никогда не в двух местах.

## 4. `@hs/core/characters` — персонажи, отношения, расписания

- **Интерфейс:**
  ```ts
  interface Character {
    id: CharacterId; name: string; archetypeId: string; age: number; socialStatus: SocialStatus;
    personality: Personality;               // trait-вектор 0..1: openness, conscientiousness, extraversion, agreeableness, neuroticism, honesty, courage, impulsivity
    biography: BiographyFact[];             // факты-фрагменты с тегами; текст собирается из шаблонов
    goals: GoalSeed[]; fears: string[]; habits: Habit[]; desires: string[];
    secrets: SecretId[];                    // ссылки на секреты (факты истины + кто знает)
    access: AccessGrant[];                  // ключи, допуски, права на локации/предметы
    routine: RoutineBlock[];                // базовое расписание
  }
  interface Relationship { readonly a: CharacterId; readonly b: CharacterId; readonly type: RelationType; readonly valence: number; readonly trust: number; readonly intensity: number; readonly history: readonly EventId[] }
  type Scores = Pick<Relationship, 'trust' | 'valence' | 'intensity'>
  type NewRelationship = Omit<Relationship, 'history'> & { history?: readonly EventId[] }
  class RelationshipGraph {
    constructor(relationships?: Iterable<NewRelationship>);
    add(relationship: NewRelationship): void;
    get(a: CharacterId, b: CharacterId, type?: RelationType): Relationship | undefined;
    neighbors(a: CharacterId): Relationship[];
    byType(type: RelationType): Relationship[];
    adjust(a: CharacterId, b: CharacterId, delta: Partial<Scores>, cause: EventId, type?: RelationType): void;
  }
  interface ScheduleOverride { characterId: CharacterId; interval: Interval; block: RoutineBlock }
  function validateRoutine(c: Pick<Character, "id" | "routine">): void;
  function whereShouldBe(c: Pick<Character, "id" | "routine">, t: GameMinutes, overrides: readonly ScheduleOverride[], calendar: Calendar): RoutineBlock;
  ```
- **Схема и JSON:** `@hs/core/characters` экспортирует `characterSchema`,
  `serializeCharacter` и `deserializeCharacter`. Схема требует все восемь черт в диапазоне
  `0..1` и отклоняет неизвестные поля, в том числе во вложенных объектах.
- **Данные профиля:** `SocialStatus` — строковый идентификатор, `BiographyFact` — фрагмент
  `{ text, tags }`, `GoalSeed` — `{ kind, weight }` с весом `0..1`, `Habit` — `{ activity }`.
  `AccessGrant` содержит `locationId`, `itemId` или оба. Секреты хранятся как ссылки.
- **Рутина:** `RoutineBlock` содержит `{ from, to, location, activity, flexibility }`.
  Границы задаются в минутах суток, гибкость — числом `0..1`. Для ночных блоков `to` может быть
  меньше `from`. `validateRoutine` требует полного покрытия суток без пересечений.
  `whereShouldBe` переводит минуты сценария в местное время через `Calendar`. Переопределения
  действуют для указанного персонажа в полуоткрытом интервале игровых минут. При пересечении
  действует последнее подходящее переопределение из списка.
- **Зависимости:** `common`, `world`, `time`.
- **Отношения:** `parent` и `child` — обратные стороны одного отношения. Симметричные
  `sibling`, `spouse`, `romance`, `friendship`, `rivalry` и `past_conflict` доступны
  с обеих сторон и разделяют оценки и историю. `debt`, `employment` и `blackmail` направлены.
  `neighbors` и `byType` возвращают направленные представления. Если между парой несколько
  отношений, `get` и `adjust` без типа выбирают первое добавленное. Доверие ограничено
  диапазоном −1…1, валентность и интенсивность — 0…1. `adjust` записывает идентификатор события.
- **Ошибки:** `CHAR_SCHEDULE_GAP` (дыра в расписании), `CHAR_SCHEDULE_OVERLAP` (пересечение),
  `CHAR_INVALID_SCHEDULE` (недопустимые границы блока), `CHAR_INVALID_ACCESS`.
- **Тесты:** расписание покрывает весь сценарий без пересечений; симметрия отношений, где
  требуется (`siblings`, `spouses`); сериализация.

## 5. `@hs/core/truth` — Truth Model

Подробно — [truth-model.md](../investigation/truth-model.md).

- **Интерфейс:**
  ```ts
  interface TruthEvent { id: EventId; t: GameMinutes; duration: number; verb: Verb; actorIds: CharacterId[]; location: LocationId; targets: EntityRef[]; causes: EventId[]; facts: Fact[]; traceIds: TraceId[]; visibility: Visibility }
  interface IncidentRecord { type: IncidentType; victimIds: CharacterId[]; culpritIds: CharacterId[]; motive: MotiveRef; means: ItemId | MethodId; keyEventIds: EventId[]; window: Interval }
  class TruthModel {
    append(e: Omit<TruthEvent, "id">): EventId;
    whereWas(c: CharacterId, t: GameMinutes): LocationId | "in_transit";
    presenceIntervals(c: CharacterId): { location: LocationId; interval: Interval }[];
    whoWasAt(loc: LocationId, iv: Interval): CharacterId[];
    possession(item: ItemId): { holder: CharacterId | LocationId; interval: Interval }[];
    causalChain(e: EventId): EventId[];
    facts(filter?: FactFilter): Fact[];
    readonly incident: IncidentRecord;
  }
  interface InvariantWorld { locations: Pick<LocationGraph, "travelTime">; items: Pick<ItemRegistry, "locate" | "history"> }   // WorldState подходит структурно
  interface InvariantViolation { invariant: 1 | 2 | 3 | 4 | 5 | 6 | 7; code: InvariantViolationCode; eventIds: EventId[]; subject?: EntityRef; minute?: GameMinutes; message: string }
  function checkTruthInvariants(tm: TruthModel, world: InvariantWorld, opts?: { incremental?: boolean }): InvariantViolation[];
  function assertInvariants(tm: TruthModel, world: InvariantWorld, opts?: { incremental?: boolean }): void;
  function withInvariantChecks(tm: TruthModel, world: InvariantWorld, debug: { enabled: boolean }): { append(e: Omit<TruthEvent, "id">): EventId };
  ```
- **Инварианты:** коды, трактовка смерти и debug-режим — [truth-model.md §4](../investigation/truth-model.md).
  `checkTruthInvariants` проверяет инварианты 1–5 и 7. Инвариант 6 проверяется в SIM-002,
  его проверка в валидаторе — OQ-13.
- **Зависимости:** `common`, `world`, `characters`.
- **Ошибки:** `TRUTH_INVARIANT_VIOLATION` — `TruthInvariantError` из `assertInvariants` и
  `withInvariantChecks` при включённом флаге.
- **Тесты:** инварианты (нет двойного присутствия, перемещения не быстрее графа, причина раньше
  следствия, предмет у одного владельца); `whereWas` на границах интервалов.

## 6. `@hs/core/knowledge` — знания, убеждения, память, ложь, показания

- **Интерфейс:**
  ```ts
  interface Belief { proposition: Proposition; confidence: number; source: "observed" | "told" | "read" | "inferred"; fromCharacter?: CharacterId; acquiredAt: GameMinutes; fuzzMinutes: number }
  class KnowledgeStore {
    add(b: Belief): void;
    query(p: PropositionPattern): Belief[];
    recall(p: PropositionPattern, now: GameMinutes): Belief | undefined;
    serialize(): string;
    static deserialize(json: string): KnowledgeStore;
  }
  interface LiePolicy { conceal: PropositionPattern[]; fabricate: Fabrication[] }   // что скрывать, что выдумывать
  function buildLiePolicy(c: Character, kb: KnowledgeStore, secrets: readonly LieMotive[], guilt?: LieMotive): LiePolicy;
  interface Statement { id: string; speakerId: CharacterId; proposition: Proposition; veracity: "true" | "mistaken" | "lie" /* скрыто от клиента */; topic: TopicId; at: GameMinutes }
  function answer(q: Question, speaker: SpeakerContext): Statement[];
  ```
- **Хранилище:** `KnowledgeStore` использует только схему, идентификатор и сопоставление пропозиций
  из `@hs/core/truth/facts`. `query` возвращает сохранённые убеждения по убыванию уверенности и
  времени получения.
  При равенстве используется возрастание `FactId`. `recall` выбирает первое совпадение, доступное
  к указанной минуте, и размывает время в возвращаемой копии.
- **Снимок:** `serialize` сохраняет JSON-массив убеждений в порядке `FactId`.
- **Ошибки:** `recall` возвращает `undefined`, когда доступного совпадения нет. Некорректные
  убеждения, минуты запроса и снимки отклоняются при проверке схемы или чтении JSON.
- **Тесты:** субъективные убеждения, размытие времени в пределах `fuzzMinutes`, детерминизм
  воспоминаний и восстановление из снимка. Для показаний также проверяется наличие мотива скрывать.

## 7. `@hs/core/simulation` — Character Simulation System

Подробно — [character-simulation.md](../simulation/character-simulation.md).

- **SIM-001:** модуль экспортирует `SimulationRunner`, `SimulationRunnerOptions`, `Agent`,
  `Activity` и `ActivityStep`. Раннер регистрирует обработчики фаз `Schedules` и `Simulation`
  в переданном `TimeSystem`. Порт `items` предоставляет `ItemRegistry.locate` и `history` для
  проверки физического владения ключами. Необязательные `exits` (GEN-008) задают минуту, с которой
  персонаж больше не действует и не наблюдает. `getAgent(characterId)` возвращает снимок текущей активности и
  состояния RNG. Целевой интерфейс ниже включает возможности следующих задач SIM.
- **Интерфейс:**
  ```ts
  interface Agent { characterId: CharacterId; lod: "focus" | "background"; activity?: Activity; goals: ActiveGoal[]; wariness: number; stress: number }
  interface Goal { id: GoalKind; score(a: Agent, w: WorldView): number; plan(a: Agent, w: WorldView, rng: Rng): Activity | null }
  class SimulationRunner implements PhaseHandler {
    constructor(deps: { time; truth; world; characters; knowledge; evidence; goals: Goal[] });
    onPlayerAction(e: PlayerActionObserved): void;   // реакции на игрока
    setFocus(location: LocationId): void;            // пересчёт LOD
  }
  ```
- **Выход:** новые `TruthEvent`, изменения знаний/отношений, новые/уничтоженные следы.
- **События:** `NpcArrived`/`NpcLeft` (видимые игроку только в его локации), `NpcConversationOverheard`,
  `EvidenceTampered` (внутреннее), `NpcMessageSent` (в телефон игрока).
- **Ошибки:** `SIM_NO_PLAN` (агент без плана — переходит к рутине, предупреждение в логе).
- **Тесты:** детерминизм; следование расписанию; сокрытие улики создаёт вторичный след;
  взаимодействие с TimeSystem; производительность (QA-002).

## 8. `@hs/core/evidence` — следы и улики

- **Интерфейс:**
  ```ts
  interface TraceRule { verb: Verb; when?: Condition; produces: TraceSpec[] }   // из content/*/trace-rules.json
  interface Trace { id: TraceId; kind: "physical" | "document" | "digital" | "testimonial"; sourceEventId: EventId; template: TemplateId; supports: ClaimRef[]; captureMode: "auto" | "qr"; location?: LocationId; itemId?: ItemId; availableFrom: GameMinutes; decaysAt?: GameMinutes; destroyedBy?: EventId; destroyedAt?: GameMinutes }
  interface Clue { id: ClueId; traceId: TraceId; supports: ClaimRef[]; discovery: DiscoveryCondition; captureMode: "auto" | "qr"; presentation: PresentationRef }
  function deriveClues(traces: Trace[], rules: ClueRules): Clue[];
  function discoverable(clue: Clue, ctx: DiscoveryContext): boolean;
  interface EvidenceTokenPort { issue(clueId: ClueId, expiresAt: GameMinutes): TokenRef }   // реализует сервер
  function compileTraceRules(input: unknown): TraceRuleSet;          // EVIDENCE_RULE_INVALID, закон сохранения
  function tracesForEvent(event: TruthEvent, rules: TraceRuleSet, items: Pick<ItemRegistry, "get">, truth?: { events(): readonly TruthEvent[] }): Trace[];
  function deriveTraces(truth: { events(): readonly TruthEvent[] }, rules: TraceRuleSet, items: Pick<ItemRegistry, "get">): Trace[];
  function isTraceAvailable(trace: Trace, t: GameMinutes): boolean;   // [availableFrom, min(decaysAt, destroyedAt))
  const CONCEALMENT_VERBS: readonly ["hide", "destroy", "stage"];
  ```
  Семантика сопоставления, полезной нагрузки, уничтожения и времени —
  [scenario-presets.md §5](../procedural-generation/scenario-presets.md), [ADR 0017](adr/0017-trace-conservation-and-payload.md).
- **Зависимости:** `truth`, `world`, `knowledge` (свидетельские следы).
- **События:** `ClueAvailable`, `ClueDestroyed`, `CaptureRequested`.
- **Ошибки:** `EVIDENCE_RULE_INVALID` (на загрузке контента).
- **Тесты:** каждое ключевое событие инцидента порождает ≥ 1 след; сокрытие порождает
  вторичный след («закон сохранения улик»); окна доступности.

## 9. `@hs/core/investigation` — Investigation Engine

Подробно — [investigation-model.md](../investigation/investigation-model.md).

- **Интерфейс:**
  ```ts
  class PlayerKnowledge {                       // packages/core/src/investigation/player-knowledge.ts (INV-001)
    readonly clues: ReadonlyMap<ClueId, DiscoveredClue>; readonly statements: readonly HeardStatement[] /* Statement без veracity */;
    readonly contacts: ReadonlySet<CharacterId>; readonly journal: readonly JournalEntry[];   // журнал по игровому времени
    addClue(c: { clueId; discoveredAt; location; captured? }): boolean;   // false: уже известно
    markCaptured(clueId: ClueId, at: GameMinutes): boolean;               // PlayerKnowledgeError INVESTIGATION_UNKNOWN_CLUE
    addStatement(s: Statement | HeardStatement): boolean;                 // veracity вырезается в рантайме
    addContact(id: CharacterId, at: GameMinutes): boolean;
    readonly suspicions: readonly Suspicion[];   // отметки игрока (INV-003)
    markSuspicion(id: CharacterId, level: "none" | "possible" | "prime", note?: string): boolean;   // без затрат времени
    serialize(): PlayerKnowledgeSnapshot;  static restore(saved: unknown): PlayerKnowledge;   // INVESTIGATION_INVALID_STATE
  }
  type Claim = { kind: "motive" | "means" | "opportunity" | "presence" | "alibi" | "no_means" | "no_access" | "contradiction"; subject: CharacterId; detail: unknown }
  function compileDeductionRules(input: unknown): DeductionRules;       // DeductionRulesError DEDUCTION_RULES_INVALID (INV-002)
  function evaluateClaims(pk: PlayerKnowledge, rules: DeductionRules, ctx?: ClaimContext): EstablishedClaim[];
  // ClaimContext = { clues: Map<ClueId, { supports }>; incident?: { location; window } } — известное игроку, не истина
  function personsOfInterest(pk: PlayerKnowledge, ctx: Pick<ClaimContext, "clues">): PersonOfInterest[];   // INV-003; подсказка, не Suspect
  function detectContradictions(pk: PlayerKnowledge, ctx: Pick<ClaimContext, "clues">, toleranceMinutes?: number): Contradiction[];   // INV-004; событие ContradictionFound — contradictionEvents()
  interface CaseFile { accusedIds: CharacterId[]; motive?: ClaimRef; means?: ClaimRef; opportunity?: ClaimRef; evidence: ClueId[] }
  function evaluateAccusation(cf: CaseFile, truth: IncidentRecord, pk: PlayerKnowledge, ctx: AccusationContext): AccusationOutcome;   // ctx = ClaimContext + rules, hallucinatedClueIds? (INV-005)
  ```
- **Зависимости:** `evidence`, `knowledge`; **доступ к `truth` только в `evaluateAccusation`.**
- **События:** `ClueDiscovered`, `StatementHeard`, `ContradictionFound`, `PersonOfInterestAdded`,
  `AccusationResolved`.
- **Ошибки:** `CASEFILE_INCOMPLETE`, `CASEFILE_UNKNOWN_EVIDENCE`.
- **Тесты:** функции, кроме `evaluateAccusation`, не импортируют `truth` (ESLint-граница);
  противоречия обнаруживаются только при наличии обеих частей; исходы обвинения.

## 10. `@hs/core/survival` — здоровье, рассудок, усталость, ресурсы, угрозы

- **Интерфейс:**
  ```ts
  interface Vitals { health: number /*0..10*/; sanity: number /*0..10*/; fatigue: number /*0..100*/ }
  interface VitalsState { vitals: Vitals; awakeMinutes: number; restedMinutes: number; trustedTalkDay: number | null }   // остатки минут: частичное время не теряется; день последнего разговора с доверенным
  interface VitalsStep { state: VitalsState; events: SurvivalEvent[]; forcedSleepMinutes?: number }
  function createVitalsState(start: Vitals): VitalsState;            // из preset.survival.startVitals
  function restoreVitalsState(saved: unknown): VitalsState;          // SURVIVAL_INVALID_STATE при повреждении
  function applyDelta(s: VitalsState, d: Partial<Vitals>, at: GameMinutes, cause: string): VitalsStep;
  function tickAwake(s: VitalsState, minutes: number, at: GameMinutes): VitalsStep;   // любое действие, кроме отдыха
  function rest(s: VitalsState, minutes: number, at: GameMinutes): VitalsStep;
  function trustedTalk(s: VitalsState, at: GameMinutes, calendar: Calendar): VitalsStep;   // рассудок +1, не чаще раза в игровой день
  function statusOf(v: Vitals): VitalsStatus;  function endingFor(v: Vitals): "death" | "madness" | undefined;
  function costModifiers(v: Vitals, opts?: { darkWithoutLight?: boolean }): CostModifier[];   // для resolveActionCost (TIME-004)
  // планируется (SURV-002/003/004):
  interface SurvivalState { vitals: VitalsState; static: number /*0..100*/; inventory: InventorySlot[]; phoneBattery: number }
  function resolveThreat(t: ThreatEncounter, s: SurvivalState, rng: Rng): ThreatOutcome;
  ```
  Вместо `applyActionStrain` показатели меняет `applyDelta`: урон и стоимость исходов (травма при
  неудачном вскрытии, нападение) решают ENG-003 и SURV-003 (с RNG) и передают готовое изменение.
- **События:** `VitalsChanged { at, before, after, cause }`, `PlayerIncapacitated { at, cause }` (реализованы в
  SURV-001), `StaticThresholdReached`, `ThreatEncountered` (SURV-002, SURV-003).
- **Ошибки:** `SURVIVAL_INVALID_STATE` (неверное стартовое или сохранённое состояние).
- Подробности формул и порядка модификаторов — [survival-horror.md](../game-design/survival-horror.md).
- **Тесты:** границы значений; отдых восстанавливает; пороги Static; исходы угроз детерминированы.

## 11. `@hs/core/phone` — домен виртуального телефона

- **Назначение:** содержимое телефона как часть игрового состояния: контакты, переписки,
  звонки, галерея, файлы (включая скрытые), заметки, метки карты, страницы браузера,
  уведомления, галлюцинации. Генерирует `PhoneView` для клиента.
- **Интерфейс:**
  ```ts
  interface PhoneState { contacts; threads; callLog; activeCall?; gallery; files; notes; mapPins; browserPages; notifications; battery: number }
  function reducePhone(s: PhoneState, e: DomainEvent): PhoneState;
  function projectPhoneView(s: PhoneState, survival: PhoneSurvival, ctx: { minute; calendar }): PhoneView;   // схема из @hs/protocol
  function initialPhoneState(templates: PhoneTemplate[], opts?): PhoneState;   // пресет → стартовый телефон героя
  ```
  `PhoneEvent` — события телефона (`MessageReceived`, `CallStarted`, `FileUnlocked`, `PhotoAdded` и т.д.);
  чужие события редьюсер игнорирует. `PhoneSurvival = { vitals, static }`; ему и времени нужны
  `signal`, `glitchLevel` и `status.time`. Проекция собирает каждое поле явно: пароли файлов,
  содержимое заблокированных файлов, скрытые файлы и `hallucination` в `PhoneView` не попадают.
- **Тесты:** каждое доменное событие отражается в нужном приложении; галлюцинации помечены
  `hallucination: true` только на сервере и не попадают в `CaseFile`.

## 12. `@hs/core/game` — GameEngine, действия, представления, сохранения

- **Загрузка сохранения.** `Regenerate` возвращает `ReplayRuntime` с обязательным полем
  `readonly generatorVersion: string` из фактически сгенерированного расследования. Перед
  восстановлением чекпойнта и replay `loadSave` сверяет его с версией файла по
  [ADR 0019](adr/0019-save-generator-compatibility.md).
- **Расследование (CORE-003):**
  ```ts
  interface WorldState { locations: LocationGraph; items: ItemRegistry; durationMinutes: number }
  interface Investigation {
    scenarioId: string; seed: string; generatorVersion: string;
    world: WorldState; characters: readonly Character[]; relationships: RelationshipGraph;
    truth: TruthModel; secrets: readonly Secret[];
  }
  interface Secret { id: string; fact: Fact; knownBy: CharacterId[] }
  function snapshotInvestigation(inv: Investigation): InvestigationSnapshot;
  function serializeInvestigation(inv: Investigation): string;
  function deserializeInvestigation(json: string): Investigation;
  ```
  `WorldState` экспортируется из `@hs/core/world`. `LocationGraph.startDateTime` задаёт начало
  календаря. `InvestigationBuilder` принимает метаданные, мир, персонажей и истину. Начальные
  отношения и секреты можно оставить пустыми. Каждый вызов `build()` создаёт независимый экземпляр.
- **Снимок расследования:** `snapshotInvestigation` возвращает JSON-данные, пригодные для
  `stateHash`. Кодирование использует `canonicalJson` и сохраняет порядок добавления событий,
  отношений и перемещений предметов в одну минуту. Загрузка проверяет структуру и ссылки,
  восстанавливает доменные классы и сообщает `INVESTIGATION_INVALID` при повреждении снимка.
  Проверка инвариантов игровой хронологии относится к TRUTH-003. Поля `clues`, `lies` и
  `phoneSeed` добавляются как необязательные по мере реализации соответствующих модулей.
  Снимок предназначен для сервера и не входит в `PlayerView` или `PhoneView`.
- **Интерфейс:**
  ```ts
  type PlayerAction = MoveAction | ExamineAction | TalkAction | InterrogateAction | ReadAction | UseItemAction | PickLockAction
    | RestAction | WaitAction | CallAction | MessageAction | BrowseAction | OpenFileAction | CaptureEvidenceAction | AccuseAction;
  class GameEngine {
    static create(inv: Investigation, ports: EnginePorts): GameEngine;
    dispatch(source: "desktop" | "phone", a: PlayerAction): DispatchResult;
    playerView(): PlayerView; phoneView(): PhoneView;   // проекции без истины
    snapshot(): GameSnapshot; static restore(s: GameSnapshot, inv: Investigation, ports): GameEngine;
    stateHash(): string;
  }
  interface DispatchResult { ok: boolean; error?: ErrorCode; minutesSpent: number; events: DomainEvent[]; outcome?: GameOutcome }
  ```
- ENG-001 принимает стартовую локацию, таблицу затрат и данные доступа игрока через `EnginePorts`.
  `move` и `wait` используют `TimeSystem.advance`; отклонённое действие сохраняет состояние.
  `GameSnapshot` содержит серверное расследование, игровую минуту, локацию игрока и хеш
  исходного расследования. Снимок остаётся на сервере.
- **ENG-003** (`game/actions`): остальные действия desktop — правила в
  [game-design.md §2](../game-design/game-design.md). Новые необязательные порты `EnginePorts`:
  ```ts
  clues?: readonly Clue[];                              // улики дела (EVD-002)
  testimony?: { witness(id): { knowledge; policy } | undefined };   // память и LiePolicy (KNOW-002)
  startVitals?: Vitals; inventory?: readonly PackItem[];            // SURV-001, SURV-004
  simulation?: { onPlayerAction(e: PlayerActionObserved): void };   // SIM-006
  attachTime?: (time: TimeSystem) => void;              // обработчики фаз; прерывание отдыха
  static?: { start?: number; endingAt100?: EndingId };  // ENG-010: Static в движке; без порта выключен
  ```
- **ENG-010** (Static в движке): при `EnginePorts.static` движок вешает `StaticTimer` на свои
  `TimeSystem` (рост +1 / 60 мин по часам, ровно по сетке часа и после `restore`), применяет
  `STATIC_DELTAS`: раскрытое противоречие −3, подтверждённое ложное обвинение +15, и отдаёт
  `StaticChanged`, `StaticThresholdReached`, `StaticOverwhelmed` в `DispatchResult.events`. Уровень —
  в `PlayerView.static` и сигнале `PhoneView`; `GameEngine.staticLevel()` — порт `staticLevel` для
  `ScenarioEvents` (TIME-006). Static 100 завершает игру концовкой `endingAt100` (по умолчанию
  `madness`), `GameSnapshot.static` хранит состояние; старые снимки восстанавливаются с `start`. При
  обвинении `hallucinationIds(phone)` добавляются в `hallucinatedClueIds`. Без порта `static` снимок
  и хеш состояния не меняются, поэтому сохранения без него загружаются. Не подключены (остаток
  ENG-010): ночь +3, находка тела +5, броски галлюцинаций по времени, реакции NPC и нападение
  виновника.
  `DispatchResult.events` — `GameEvent[]`: события часов, показателей, `PlayerKnowledge`,
  действий и `PlayerActionObserved`. `GameSnapshot.desktop` хранит `PlayerKnowledge`, серверные
  показания с `veracity`, осмотренные локации и точки, открытые двери, диалог, показатели и
  рюкзак. Новые игры включают это поле с первого снимка. Для сохранения той же версии генератора
  загрузчик также узнаёт начальное состояние до ENG-003 по полному хешу. В старой части журнала
  только `move` и `wait` меняли состояние, показатели и модификаторы desktop ещё отсутствовали.
  При продолжении игры первое успешное действие создаёт `desktop` со стартовыми параметрами и
  применяет текущие правила. При полном replay границу определяет хеш записи: если старый переход
  не совпал, текущий переход выполняется из того же проверенного состояния. После появления
  `desktop` все следующие хеши включают его. Цепочка журнала, чекпойнт и итоговый хеш проверяются
  по ADR 0014 в обоих случаях. `PlayerView` заполняет
  точки интереса, доску дела (улики, показания, противоречия), `interaction`, показатели и рюкзак.
- **ENG-006** (`game/actions/accuse.ts`, `game/ending.ts`): `accuse` требует `EnginePorts.accusation
  { rules, incident?, hallucinatedClueIds? }` (иначе `ACTION_NOT_AVAILABLE`); `incident` — инцидент,
  как его выяснил игрок, а не истинный. `confirm: false` только возвращает событие
  `AccusationConfirmationRequired` и ничего не меняет; `confirm: true` вызывает `evaluateAccusation`
  (`CASEFILE_*`, неизвестный обвиняемый → `ACTION_INVALID`), время не тратится. Верное обвинение
  (`solved`, `partial`), второе ложное или ложное без оставшегося времени ставят `verdict` и
  завершают игру (`outcome` результата — id концовки); первое ложное при оставшемся времени
  прощается один раз (`failedAccusations`), игра идёт дальше. Событие `AccusationMade` несёт
  `result`, `proven`, `final` и не называет виновных. `AccusationOutcome` с `consequences`
  (в них есть `characterId` виновных) уходит только в серверный порт
  `simulation.onAccusation`, не в `events` и не в `PlayerView`. `endingOf` определяет концовку:
  вердикт, затем `death`/`madness` по показателям, затем `time_up` по часам; после неё любое
  действие — `GAME_OVER`, `availableActions` пуст. `PlayerView.ending` с `recap` (`TruthRecap`:
  `responsible` — единственная проекция истины клиенту) появляется только когда игра окончена.
- **Блокировка взаимодействия (ENG-005, `game/interaction.ts`):** `blockReason(action, context)` —
  чистая матрица открытого диалога (`talk` или `interrogation`) и состояния звонка
  (`EnginePorts.callState`) против нового действия. Открытый диалог блокирует `call` и `answerCall`;
  допрос (`interrogation`, признак в `ActiveInteraction`) дополнительно блокирует `move`, `pickLock`
  и `rest`, остальные действия допрос завершают; активный или входящий звонок блокирует `talk` и
  `interrogate`, входящий — ещё и `call`. Отказ: `ACTION_BLOCKED` и `DispatchResult.blockedReason`
  (`dialogue_open`, `interrogation_open`, `call_ringing`, `call_active`); состояние не меняется.
- **Действия телефона (ENG-004, `game/actions/phone.ts`):** `call`, `answerCall`, `callChoice`,
  `message`, `browse`, `openFile`, `unlockFile`, `addNote`, `captureEvidence`. Телефон героя —
  `PhoneRuntime` (`PhoneState`, остаток минут заряда, счётчик id, очередь ответов); он есть, только
  если задан порт `EnginePorts.phone?: PhonePort`, иначе все действия телефона дают
  `ACTION_NOT_AVAILABLE`. `PhonePort` (всё необязательно): `initial` — стартовый `PhoneState`;
  `callGreeting` (ответ контакта и темы звонка; `undefined` — не ответил, звонок «пропущен»),
  `callReply` (ответ на тему, длительность, конец разговора), `messageReply` (задержка и текст
  ответа NPC на шаблон). Движок сам ничего не решает: ответ приходит через `delayMinutes`,
  выбранный симуляцией, и доставляется (`MessageReceived`, уведомление) при следующем продвижении
  времени. Правила: звонок только контакту из `PhoneState.contacts` и без активного звонка;
  `message` — только шаблон из `availableReplies` существующей переписки; `unlockFile` — скрытый
  заблокированный файл недоступен, неверный пароль тратит минуту (`FileUnlockAttempted`);
  закрытый на пароль файл не открыть без `unlockFile`. `captureEvidence` принимает только токен
  текущей `pendingCapture` (место, срок): помечает улику как зафиксированную (`captured: true`),
  снимает `pendingCapture`, добавляет снимок в галерею; сервер диспатчит его с ролью `phone` после
  `qr.scan`, хотя в `ACTIONS_BY_ROLE` его нет. Время: `call` и `message` по таблице затрат,
  `callChoice` — по `minutes` ответа порта, остальные — 1 минута. Заряд: −1 % за 10 минут любого
  времени (остаток переносится), −2 % за соединённый звонок, −1 % за снимок; на 0 % все действия
  телефона отклоняются (зарядка в номере не реализована). Действия телефона не пишутся в журнал
  истины, не создают `PlayerActionObserved` и не закрывают диалог. `GameEngine.receivePhoneEvent`
  принимает события симуляции (входящий звонок, сообщение), `phoneView()` отдаёт `PhoneView`;
  `GameSnapshot.phone` есть только у движка с телефоном.
- **Ошибки:** `ACTION_INVALID`, `ACTION_NOT_AVAILABLE`, `ACTION_BLOCKED`, `GAME_OVER`.
- **Тесты:** каждое действие тратит время по таблице; проекции не содержат полей истины
  (тест сканирует JSON на запрещённые ключи `veracity`, `culpritIds`, `truth`); replay.

---

## 13. `@hs/generator` — конвейер генерации

Подробно — [generation-pipeline.md](../procedural-generation/generation-pipeline.md).

```ts
interface Stage<I, O> { name: string; run(input: I, ctx: GenerationContext): O }   // ctx.rng = rng.fork("gen/" + name)
function generateInvestigation(req: { scenarioId: string; seed: string }, content: ScenarioContent, options?: { maxAttempts?: number; checks?: Check[]; now?: () => number }): GenerationResult;
interface GenerationResult { ok: true; investigation: Investigation; investigationHash: string; report: InvestigationReport; server: ServerGenerationPayload } | { ok: false; error: "GENERATION_UNSOLVABLE"; report: InvestigationReport }   // шлюз валидации, ADR 0006 (GEN-011)
// Закрытые данные принятой попытки (GEN-013): только на сервере, не в PlayerView/PhoneView, REST, логах и выводе hs-gen.
// Те же объекты, что проверил шлюз; хватает для EnginePorts.clues / testimony / accusation.rules / startLocationId.
interface ServerGenerationPayload { attempt: number; startLocationId: string; clues: Clue[]; requiredClueIds: string[]; knowledge: ReadonlyMap<CharacterId, KnowledgeStore>; liePolicies: ReadonlyMap<CharacterId, LiePolicy>; testimony: Statement[]; statements: HeardStatement[]; deductionRules: DeductionRules }
// CLI: packages/generator/bin/hs-gen.ts --scenario <id> --seed <s> [--debug-truth]
const GENERATOR_VERSION: string;
class GenerationRejection extends Error { code: string; diagnostics?: Record<string, unknown> }   // стадия отклоняет вход → следующая попытка
const incidentSelection: Stage<ConflictWorld & { world: GeneratedWorld }, IncidentWorld>;        // IncidentPlan + IncidentReport (GEN-006)
function assessIncidents(input, content): IncidentAssessment;   // все допустимые виновники по жертвам и шаблонам, без случайности
function selectIncident(input, assessment, content, rng): IncidentWorld;   // выбор жертвы, шаблона и виновника (score^γ) на готовой оценке
const historySimulation: Stage<PlotWorld, HistoryWorld>;   // TruthModel с IncidentRecord, знания, отношения и позиции на t = 0 (GEN-008)
```
**Зависимости:** `@hs/core`, `@hs/validator` (шлюз). **Тесты:** каждая стадия отдельно на фикстурах;
golden-снимки для 5 seed; распределение виновников.

## 14. `@hs/validator` — проверки расследований и seed sweep

Подробно — [validation.md](../investigation/validation.md).

```ts
interface Check { id: string; severity: "error" | "warning"; run(inv: Investigation): CheckResult }
function validateInvestigation(inv: Investigation, opts?): ValidationReport;
function solve(inv: Investigation, opts: { timeBudget: GameMinutes }): SolutionPath | null;   // планировщик по времени, VAL-003
// Солвер решаемости (VAL-002, validator/solver): без учёта времени, возвращает Solution (клеймы, достижимость)
function solveDeduction(input: { investigation; clues: Clue[]; rules: DeductionRules; statements?; startLocationId? }): Solution;
// Check.run(inv, ctx: ValidationContext): FindingInput[]; SOLVER_CHECKS = V-REACHABLE, V-CULPRIT-PROVABLE, V-UNIQUE
// CLI: hs-sweep --scenario sanatorium_winter --count 1000 --from 0 --out reports/
```
**Зависимости:** `@hs/core` (без `@hs/generator`, чтобы не было цикла; sweep-CLI живёт в
`packages/validator/bin` и импортирует генератор динамически). **Тесты:** валидатор отвергает
намеренно сломанные расследования (мутационные фикстуры).

## 15. `@hs/protocol` — схемы

См. [protocol.md](../backend/protocol.md). Экспорт: zod-схемы, типы, `PROTOCOL_VERSION`,
`ErrorCode`, JSON Schema, фикстуры. **Зависимости:** только `zod`.

## 16. `apps/server` — Session Server

См. [backend.md](../backend/backend.md). Модули: `sessions`, `pairing`, `gateway`, `views`, `qr`,
`saves`, `diagnostics`, `config`.

## 17. `apps/mobile` — Companion App

См. [mobile-app.md](../mobile/mobile-app.md). Модули: `os` (оболочка), `os-apps/*` (приложения
по манифестам), `connection` (WS), `stores`, `camera`, `pairing`.

## 18. `apps/desktop` — Godot Client

См. [godot-client.md](../desktop/godot-client.md). Autoload: `Backend`, `GameStore`,
`SceneRouter`, `Settings`, `AudioDirector`, `ServerLauncher`.
