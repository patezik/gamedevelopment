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
    travelTime(a, b, who?: Actor): number | null;
    path(a, b, who?: Actor): LocationId[];
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
  function checkTruthInvariants(tm: TruthModel, world: WorldState): InvariantViolation[];
  ```
- **Зависимости:** `common`, `world`, `characters`.
- **Ошибки:** `TRUTH_INVARIANT_VIOLATION` (в тестах и debug-сборке — исключение).
- **Тесты:** инварианты (нет двойного присутствия, перемещения не быстрее графа, причина раньше
  следствия, предмет у одного владельца); `whereWas` на границах интервалов.

## 6. `@hs/core/knowledge` — знания, убеждения, память, ложь, показания

- **Интерфейс:**
  ```ts
  interface Belief { proposition: Proposition; confidence: number; source: "observed" | "told" | "read" | "inferred"; fromCharacter?: CharacterId; acquiredAt: GameMinutes; fuzzMinutes: number }
  class KnowledgeStore { add(b: Belief): void; query(p: PropositionPattern): Belief[]; recall(p, now): Belief | undefined /* с размытием времени */ }
  interface LiePolicy { conceal: PropositionPattern[]; fabricate: Fabrication[] }   // что скрывать, что выдумывать
  function buildLiePolicy(c: Character, truth: TruthModel, kb: KnowledgeStore): LiePolicy;
  interface Statement { id: string; speakerId: CharacterId; proposition: Proposition; veracity: "true" | "mistaken" | "lie" /* скрыто от клиента */; topic: TopicId; at: GameMinutes }
  function answer(q: Question, speaker: SpeakerContext): Statement[];
  ```
- **Зависимости:** `truth`, `characters`.
- **Ошибки:** нет (отсутствие знания → ответ «не знаю» / уклонение).
- **Тесты:** персонаж не знает того, чего не наблюдал/не слышал; ложь только при наличии мотива
  скрывать; размытие времени в пределах `fuzzMinutes`; детерминизм ответов.

## 7. `@hs/core/simulation` — Character Simulation System

Подробно — [character-simulation.md](../simulation/character-simulation.md).

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
  interface Trace { id: TraceId; kind: "physical" | "document" | "digital" | "testimonial"; sourceEventId: EventId; location?: LocationId; itemId?: ItemId; availableFrom: GameMinutes; decaysAt?: GameMinutes; destroyedBy?: EventId }
  interface Clue { id: ClueId; traceId: TraceId; supports: ClaimRef[]; discovery: DiscoveryCondition; captureMode: "auto" | "qr"; presentation: PresentationRef }
  function deriveClues(traces: Trace[], rules: ClueRules): Clue[];
  function discoverable(clue: Clue, ctx: DiscoveryContext): boolean;
  interface EvidenceTokenPort { issue(clueId: ClueId, expiresAt: GameMinutes): TokenRef }   // реализует сервер
  function compileTraceRules(input: unknown): TraceRuleSet;          // EVIDENCE_RULE_INVALID
  function tracesForEvent(event: TruthEvent, rules: TraceRuleSet, items: Pick<ItemRegistry, "get">): Trace[];
  function deriveTraces(truth: { events(): readonly TruthEvent[] }, rules: TraceRuleSet, items: Pick<ItemRegistry, "get">): Trace[];
  ```
  Семантика сопоставления и времени — [scenario-presets.md §5](../procedural-generation/scenario-presets.md).
- **Зависимости:** `truth`, `world`, `knowledge` (свидетельские следы).
- **События:** `ClueAvailable`, `ClueDestroyed`, `CaptureRequested`.
- **Ошибки:** `EVIDENCE_RULE_INVALID` (на загрузке контента).
- **Тесты:** каждое ключевое событие инцидента порождает ≥ 1 след; сокрытие порождает
  вторичный след («закон сохранения улик»); окна доступности.

## 9. `@hs/core/investigation` — Investigation Engine

Подробно — [investigation-model.md](../investigation/investigation-model.md).

- **Интерфейс:**
  ```ts
  class PlayerKnowledge { clues: Map<ClueId, DiscoveredClue>; statements: Statement[] /* без veracity */; contacts: Set<CharacterId>; journal: JournalEntry[] }
  type Claim = { kind: "motive" | "means" | "opportunity" | "presence" | "alibi" | "contradiction"; subject: CharacterId; detail: unknown }
  function evaluateClaims(pk: PlayerKnowledge, rules: DeductionRules): EstablishedClaim[];
  function personsOfInterest(pk: PlayerKnowledge): PersonOfInterest[];   // Suspect — производное от знаний игрока
  function detectContradictions(pk: PlayerKnowledge): Contradiction[];
  interface CaseFile { accusedIds: CharacterId[]; motive?: ClaimRef; means?: ClaimRef; opportunity?: ClaimRef; evidence: ClueId[] }
  function evaluateAccusation(cf: CaseFile, truth: IncidentRecord, pk: PlayerKnowledge): AccusationOutcome;
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
  interface SurvivalState { vitals: Vitals; static: number /*0..100*/; inventory: InventorySlot[]; phoneBattery: number }
  function applyActionStrain(s: SurvivalState, a: ActionKind, ctx): SurvivalDelta;
  function costModifiers(s: SurvivalState): CostModifier[];   // для TimeSystem
  function resolveThreat(t: ThreatEncounter, s: SurvivalState, rng: Rng): ThreatOutcome;
  ```
- **События:** `VitalsChanged`, `StaticThresholdReached`, `ThreatEncountered`, `PlayerIncapacitated`.
- **Тесты:** границы значений; отдых восстанавливает; пороги Static; исходы угроз детерминированы.

## 11. `@hs/core/phone` — домен виртуального телефона

- **Назначение:** содержимое телефона как часть игрового состояния: контакты, переписки,
  звонки, галерея, файлы (включая скрытые), заметки, метки карты, страницы браузера,
  уведомления, галлюцинации. Генерирует `PhoneView` для клиента.
- **Интерфейс:**
  ```ts
  interface PhoneState { contacts; threads; callLog; activeCall?; gallery; files; notes; mapPins; browserPages; notifications; battery: number }
  function reducePhone(s: PhoneState, e: DomainEvent): PhoneState;
  function projectPhoneView(s: PhoneState, survival: SurvivalState): PhoneView;   // схема из @hs/protocol
  ```
- **Тесты:** каждое доменное событие отражается в нужном приложении; галлюцинации помечены
  `hallucination: true` только на сервере и не попадают в `CaseFile`.

## 12. `@hs/core/game` — GameEngine, действия, представления, сохранения

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
- **Блокировка взаимодействия:** во время диалога или звонка (`activeInteraction`) действия,
  несовместимые с ним, отклоняются `ACTION_BLOCKED` (ENG-005).
- **Ошибки:** `ACTION_INVALID`, `ACTION_NOT_AVAILABLE`, `ACTION_BLOCKED`, `GAME_OVER`.
- **Тесты:** каждое действие тратит время по таблице; проекции не содержат полей истины
  (тест сканирует JSON на запрещённые ключи `veracity`, `culpritIds`, `truth`); replay.

---

## 13. `@hs/generator` — конвейер генерации

Подробно — [generation-pipeline.md](../procedural-generation/generation-pipeline.md).

```ts
interface Stage<I, O> { name: string; run(input: I, ctx: GenerationContext): O }   // ctx.rng = rng.fork("gen/" + name)
function generateInvestigation(req: { scenarioId: string; seed: string }, content: ContentRepo): GenerationResult;
interface GenerationResult { ok: true; investigation: Investigation; report: GenerationReport } | { ok: false; error: "GENERATION_UNSOLVABLE"; report: GenerationReport }
const GENERATOR_VERSION: string;
```
**Зависимости:** `@hs/core`, `@hs/validator` (шлюз). **Тесты:** каждая стадия отдельно на фикстурах;
golden-снимки для 5 seed; распределение виновников.

## 14. `@hs/validator` — проверки расследований и seed sweep

Подробно — [validation.md](../investigation/validation.md).

```ts
interface Check { id: string; severity: "error" | "warning"; run(inv: Investigation): CheckResult }
function validateInvestigation(inv: Investigation, opts?): ValidationReport;
function solve(inv: Investigation, opts: { timeBudget: GameMinutes }): SolutionPath | null;
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
