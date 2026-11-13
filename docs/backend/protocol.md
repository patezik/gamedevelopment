# Протокол взаимодействия (WebSocket)

Схемы — `@hs/protocol` (zod), решения — [ADR 0009](../architecture/adr/0009-protocol-schemas.md),
безопасность — [ADR 0008](../architecture/adr/0008-pairing-and-security.md).

Сгенерированные JSON Schema лежат в `packages/protocol/schemas/` (`npm run protocol:gen`; актуальность
проверяет `npm run protocol:check`), пример конверта — `packages/protocol/fixtures/envelope.json`.

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

## 3. Каталог сообщений

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

## 4. Действия по ролям

| Действие | desktop | phone |
|----------|:-------:|:-----:|
| `move`, `examineLocation`, `examineHotspot`, `talk`, `interrogate`, `read`, `useItem`, `pickLock`, `rest`, `wait`, `accuse` | ✓ | — |
| `markSuspicion` (без затрат времени) | ✓ | — |
| `call`, `answerCall`, `callChoice`, `message`, `browse`, `openFile`, `unlockFile`, `addNote` | — | ✓ |
| `captureEvidence` | — | через `qr.scan` |

Сервер проверяет роль: действие не своей роли → `ACTION_INVALID`.

## 5. Коды ошибок (`ErrorCode`)

`INVALID_MESSAGE`, `UNAUTHORIZED`, `PROTOCOL_MISMATCH`, `SESSION_NOT_FOUND`, `SESSION_CLOSED`,
`SCENARIO_NOT_FOUND`, `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`, `PAIRING_RATE_LIMITED`,
`DEVICE_REVOKED`, `ACTION_INVALID`, `ACTION_NOT_AVAILABLE`, `ACTION_BLOCKED`, `GAME_OVER`,
`QR_INVALID`, `QR_WRONG_SESSION`, `QR_EXPIRED`, `QR_ALREADY_USED`, `QR_PRECONDITION_FAILED`,
`SAVE_NOT_FOUND`, `SAVE_DESYNC`, `GENERATION_UNSOLVABLE`, `RATE_LIMITED`, `INTERNAL`.

## 6. Представления (сокращённо)

```ts
interface PlayerView {
  clock: { t: GameMinutes; day: number; time: string; period: DayPeriod; remainingMinutes: number };
  location: { id; name; description; lighting; hotspots: HotspotView[]; exits: ExitView[] };
  presentCharacters: { id; name; portraitRef; demeanor }[];
  availableActions: { action: PlayerAction; label; costPreview: { min: number; max: number }; blockedReason? }[];
  vitals: { health; sanity; fatigue }; static: number; inventory: ItemView[];
  caseBoard: { clues: ClueView[]; statements: StatementView[]; contradictions; personsOfInterest; suspicions; timeline };
  pendingCapture?: { tokenId: string; clueTitle: string; expiresInMinutes: number };
  interaction?: DialogueView;  phone: { paired: boolean; online: boolean; battery: number };
  ending?: EndingView;
}
interface PhoneView {
  status: { time: string; battery: number; signal: number /* Static → «помехи» */ };
  apps: { id: string; badge: number; enabled: boolean }[];
  contacts; threads; callLog; activeCall?; gallery; files; notes; mapPins; browserPages; notifications;
  effects: { glitchLevel: number; wallpaperVariant?: string };
}
```

Поля истины (`veracity`, `culpritIds`, `truth`, `hallucination`) **запрещены** в представлениях;
тест ENG-002 проверяет это на сериализованных снимках.

## 7. Последовательности

**Привязка:** desktop `POST /sessions` → показывает QR → phone `POST /pair` → phone WS `hello{phone}` →
сервер шлёт `peer.status` обоим → desktop разблокирует «Начать расследование».

**Возобновление:** соединение оборвалось → клиент повторяет подключение с экспоненциальной
задержкой 0,5 → 1 → 2 → 4 → 8 с (максимум 8, с джиттером ±20 %) → `hello` с `resume` →
досылка событий или `resync`.
