# Протокол взаимодействия (WebSocket)

Схемы — `@hs/protocol` (zod), решения — [ADR 0009](../architecture/adr/0009-protocol-schemas.md),
безопасность — [ADR 0008](../architecture/adr/0008-pairing-and-security.md).

Сгенерированные JSON Schema лежат в `packages/protocol/schemas/`, GDScript-константы для Godot —
в `apps/desktop/src/net/protocol_constants.gd` (`npm run protocol:gen`; актуальность обоих проверяет
`npm run protocol:check`, см. [godot-client.md §2.1](../desktop/godot-client.md#21-константы-протокола)),
пример конверта — `packages/protocol/fixtures/envelope.json`.
Примеры всех сообщений собраны в `client-messages.json` и `server-messages.json` в том же каталоге.

## 1. Транспорт

- `ws://<host>:7420/ws` — одно соединение на клиента. JSON, UTF-8, максимум 256 КБ на сообщение.
- `PROTOCOL_VERSION = 1`.

## 2. Конверт

```json
{ "v": 1, "type": "action.request", "id": "c-0192", "seq": 57, "ack": 56, "payload": { } }
```

| Поле | Смысл |
|------|-------|
| `v` | версия протокола |
| `type` | тип сообщения (каталог ниже) |
| `id` | уникальный id сообщения отправителя (для корреляции ответов) |
| `seq` | только сервер → клиент: монотонный номер события сессии (для `event`, `view.update`) |
| `ack` | клиент → сервер: последний обработанный `seq` |
| `payload` | данные по схеме типа |

Правила разбора (`Envelope` в `@hs/protocol`):

- `payload` обязателен и всегда объект (для `ping` — `{}`); его схему задаёт `type` (PROTO-001).
- Конверт строгий: неизвестные поля отклоняются (`INVALID_MESSAGE`).
- `v` проверяется только как положительное целое, а не равенство `PROTOCOL_VERSION`: сервер обязан
  разобрать конверт клиента другой версии, чтобы ответить `PROTOCOL_MISMATCH`.

## 3. Каталог сообщений

`parseClientMessage` и `parseServerMessage` принимают уже разобранный JSON и возвращают
`{ ok: true, message }` или `{ ok: false, error: "INVALID_MESSAGE" }`. При разборе проверяются
тип, направление и поля сообщения. Для проверки версии на сервере сначала разбирается общий
`Envelope`, затем сравнивается `v` и только после этого проверяется payload по каталогу.
Счётчики и `minutesSpent` — неотрицательные целые. Идентификаторы и ссылки — непустые строки.

### Клиент → сервер

| type | payload | Кто |
|------|---------|-----|
| `hello` | `{ role: "desktop" \| "phone", token, appVersion, resume?: { lastSeq, stateVersion } }` | оба |
| `ping` | `{}` | оба |
| `action.request` | `{ action: PlayerAction }` | оба (набор действий зависит от роли) |
| `qr.scan` | `{ raw: string }` | phone |
| `phone.ui` | `{ kind: "appOpened" \| "notificationRead", ref }` — не влияет на игру, для статистики и мелких эффектов | phone |

### Сервер → клиент

| type | payload |
|------|---------|
| `welcome` | `{ sessionId, role, protocolVersion, serverVersion, stateVersion, lastSeq }` |
| `pong` | `{}` |
| `view.update` | `{ stateVersion, view: PlayerView \| PhoneView }` |
| `event` | `{ event: ClientEvent }` (уведомление, входящий звонок, результат скана, конец игры) |
| `action.result` | `{ requestId, ok, error?, minutesSpent, interrupted? }` |
| `qr.result` | `{ ok, error?, clueRef? }` |
| `resync` | `{ reason }` → за ним следует `view.update` |
| `error` | `{ code: ErrorCode, message, requestId? }` |
| `peer.status` | `{ desktop: "online" \| "offline", phone: "online" \| "offline" \| "unpaired" }` |

Варианты `ClientEvent` по полю `type`: `notification` с `notificationId`, `incomingCall`
с `callId`, `scanResult` с полями `qr.result`, `gameOver` без дополнительных полей.
Схема `view.update` проверяет, что `view` — это `PlayerView` или `PhoneView` (§6); сообщение с пустым
или смешанным `view` отвергается.

## 4. Действия по ролям

| Действие | desktop | phone |
|----------|:-------:|:-----:|
| `move`, `examineLocation`, `examineHotspot`, `talk`, `interrogate`, `read`, `useItem`, `pickLock`, `rest`, `wait`, `accuse` | ✓ | — |
| `markSuspicion` (без затрат времени) | ✓ | — |
| `call`, `answerCall`, `callChoice`, `message`, `browse`, `openFile`, `unlockFile`, `addNote` | — | ✓ |
| `captureEvidence` | — | через `qr.scan` |

Сервер проверяет роль: действие не своей роли → `ACTION_INVALID`.
Таблица `ACTIONS_BY_ROLE` перечисляет действия для прямого `action.request`. Сервер
сам создаёт `captureEvidence { tokenId }` после проверки `qr.scan`.

Действия различаются по полю `type`. Остальные поля перечислены ниже.

| Действие | Поля |
|----------|------|
| `move` | `locationId` |
| `examineLocation` | — |
| `examineHotspot` | `hotspotId` |
| `talk` | `characterId, topicId` |
| `interrogate` | `characterId, subject`, где `subject` — `{ type: "evidence", clueId }` или `{ type: "contradiction", contradictionId }` |
| `read` | `documentId` |
| `useItem` | `itemId, targetId?` |
| `pickLock` | `targetId` |
| `rest`, `wait` | `minutes` — положительное целое |
| `accuse` | `caseFile: { accusedIds, motive?, means?, opportunity?, evidence }, confirm`; `confirm` — логическое значение |
| `markSuspicion` | `characterId, level, note?`; `level` — неотрицательное целое |
| `call` | `contactId` |
| `answerCall` | `callId` |
| `callChoice` | `choiceId` |
| `message` | `contactId, templateId` |
| `browse` | `pageId` |
| `openFile` | `fileId` |
| `unlockFile` | `fileId, password` |
| `addNote` | `text` |

## 5. Коды ошибок (`ErrorCode`)

`INVALID_MESSAGE`, `UNAUTHORIZED`, `PROTOCOL_MISMATCH`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`,
`SCENARIO_NOT_FOUND`, `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`, `PAIRING_RATE_LIMITED`,
`DEVICE_REVOKED`, `ACTION_INVALID`, `ACTION_NOT_AVAILABLE`, `ACTION_BLOCKED`, `GAME_OVER`,
`QR_INVALID`, `QR_WRONG_SESSION`, `QR_EXPIRED`, `QR_ALREADY_USED`, `QR_PRECONDITION_FAILED`,
`SAVE_NOT_FOUND`, `SAVE_DESYNC`, `GENERATION_UNSOLVABLE`, `RATE_LIMITED`, `INTERNAL`.

## 6. Представления

Схемы — `packages/protocol/src/views` (`PlayerView`, `PhoneView` и вложенные типы), JSON Schema —
`schemas/player-view.json` и `schemas/phone-view.json`, примеры — `fixtures/views/*.json`
(`start`, `mid`, `end` и дополнительные для каждого представления; клиенты разрабатываются по ним
параллельно с ядром). Сообщение `view.update` несёт `PlayerView` на desktop-соединении и `PhoneView`
на phone-соединении. Все объекты **строгие**: неизвестный ключ на любой глубине отвергается.

`GameEngine.playerView()` строит `PlayerView` по текущей минуте и локации. В список персонажей
попадают только те, чьё присутствие в комнате подтверждено на эту минуту. Доступные переходы
используют те же ограничения доступа и расчёт стоимости, что и `dispatch`. Для ожидания
предлагается минимальная положительная длительность из таблицы стоимостей. При истечении времени
действия больше не предлагаются. Для активной QR-фиксации передаются токен, подпись и оставшееся
время. Доска дела, инвентарь, показатели и статус телефона заполняются в соответствующих задачах.

Единицы и диапазоны: время — `GameMinutes` (целые минуты, в предыстории отрицательные), `clock.time`
и `status.time` — `HH:mm`; `health`, `sanity` — 0–10; `fatigue`, `static`, `battery`, `signal`,
`glitchLevel` — 0–100 (`signal` падает с ростом `static`).

```ts
interface PlayerView {
  clock: { t; day; time: "HH:mm"; period: "morning"|"day"|"evening"|"night"; remainingMinutes };
  location: { id; name; description; lighting: "bright"|"dim"|"dark";
              hotspots: { id; name; examined }[];                       // examined — история игрока, не «есть ли улика»
              exits: { locationId; name; minutes; blockedReason? }[] };
  presentCharacters: { id; name; portraitRef; demeanor }[];
  availableActions: { action: PlayerAction; label; costPreview: { min; max }; blockedReason? }[];
  vitals: { health; sanity; fatigue }; static; inventory: { id; name; description }[];
  caseBoard: {
    clues: { id; title; description; kind: "physical"|"document"|"digital"|"testimonial";
             discoveredAt; locationId; captured }[];
    statements: { id; characterId; topicId; text; heardAt }[];
    contradictions: { id; statementId; againstId; summary }[];          // только когда у игрока есть обе стороны
    personsOfInterest: { characterId; name; linkedClueIds }[];
    suspicions: { characterId; level: "none"|"possible"|"prime"; note? }[];
    timeline: { id; from; to?; text; sourceIds }[];
  };
  pendingCapture?: { tokenId; clueTitle; expiresInMinutes };
  interaction?: { characterId; characterName;                           // DialogueView
                  topics: { id; label; costPreview }[];
                  presentable: { type: "evidence"|"contradiction"; id; label }[];
                  history: { speaker: "player"|"other"; text; at }[] };
  phone: { paired; online; battery };
  ending?: { endingId: "solved"|"partial"|"wrong_accusation"|"time_up"|"death"|"madness";
             title; text; proven?: { motive; means; opportunity };
             recap?: { summary; responsible: { id; name }[] } };        // разбор истины, только в концовке
}
interface PhoneView {
  status: { time; battery; signal };
  apps: { id; badge; enabled }[];
  contacts: { id; name; number; portraitRef? }[];                       // неизвестный номер: name показывает номер или пуст
  threads: { id; contactId; messages: { id; from: "me"|"them"; text; at; read }[];
             availableReplies: { id; text }[]; unread; typing? }[];
  callLog: { id; contactId; direction: "incoming"|"outgoing"|"missed"; at; durationMinutes }[];
  activeCall?: { callId; contactId; state: "ringing"|"active";
                 lines: { speaker: "player"|"other"; text }[]; choices: { id; text }[] };
  gallery: { id; title; imageRef; takenAt; caption? }[];
  files: { id; name; locked; passwordHint?; content? }[];               // locked ⇒ без content
  notes: { id; source: "auto"|"player"; text; at }[];
  mapPins: { id; locationId; label; seenAt? }[];
  browserPages: { id; title; url; text }[];
  notifications: { id; appId; title; text; at; read }[];
  effects: { glitchLevel; wallpaperVariant? };
}
```

**Истина не покидает сервер.** Поля `veracity`, `culpritIds`, `truth`, `hallucination`
(`FORBIDDEN_VIEW_KEYS`) **запрещены** в представлениях. Защита двойная: тесты `@hs/protocol`
проверяют, что ни схемы, ни фикстуры не содержат таких ключей (и вообще ключей с корнями
`veracity`/`culprit`/`hallucinat`/`truth`), а строгость схем отвергает любой лишний ключ на любой
глубине, то есть проекция, по ошибке скопировавшая объект истины, не пройдёт валидацию. Тест ENG-002
проверяет то же на сериализованных снимках.

Правила, закладываемые в форму данных:

- **Галлюцинации неотличимы по структуре.** Элементы телефона (например, снимок в `gallery`) имеют
  одинаковые поля независимо от происхождения; признак «галлюцинация» существует только на сервере
  (survival-horror.md §5). Игрок распознаёт их опытным путём, а не по форме данных.
- **Единственное легальное раскрытие истины** — `ending.recap`, и только в концовке (ENG-006). Поле
  названо нейтрально (`responsible`), чтобы запрещённые ключи не появлялись ни в одном представлении.
- Запертый файл не несёт `content` (проверяется схемой): содержимое приходит только после `unlockFile`.

## 7. Последовательности

**Привязка:** desktop `POST /sessions` → показывает QR → phone `POST /pair` → phone WS `hello{phone}` →
сервер шлёт `peer.status` обоим → desktop разблокирует «Начать расследование».

**Возобновление:** соединение оборвалось → клиент повторяет подключение с экспоненциальной
задержкой 0,5 → 1 → 2 → 4 → 8 с (максимум 8, с джиттером ±20 %) → `hello` с `resume` →
досылка событий или `resync`.

Токен передаётся в `hello` в первые 5 секунд. Шлюз получает роль из записи токена и сверяет её
с ролью в сообщении. URL с параметрами отклоняется. После входа клиент шлёт `ping` примерно раз
в 10 секунд и получает `pong`. После 30 секунд без корректного сообщения шлюз закрывает сокет.
Повторный вход той же роли заменяет её прежнее соединение.

Буфер хранит последние 200 исходящих `event` и `view.update` на сессию. Нумерация общая для
сессии, поэтому между сообщениями одной роли возможны пропуски номеров. При возобновлении шлюз
досылает только сообщения этой роли. `ack` отмечает последний обработанный номер и не удаляет
записи из буфера. При утрате записи для роли или несовместимой версии состояния шлюз посылает
`resync` и запрашивает снимок для роли.

После каждого успешного `dispatch` `stateVersion` растёт на 1. Шлюз отправляет `action.result`
отправителю, затем `view.update` каждой роли со своей проекцией и события, видимые роли (источник
проекций `snapshot` и событий `events` задаёт приложение). `gameOver` получают обе роли. Последняя
проекция роли кэшируется по `stateVersion` и используется при `resync` и входе клиента.
