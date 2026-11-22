# СГЕНЕРИРОВАНО — не редактировать.
# Источник: @hs/protocol (packages/protocol/src). Обновление: npm run protocol:gen.
# Актуальность проверяют npm run protocol:check и тесты @hs/protocol.
class_name ProtocolConstants
extends RefCounted

## Версия протокола (ADR 0009); при несовпадении сервер отвечает PROTOCOL_MISMATCH.
const PROTOCOL_VERSION: int = 1

# Типы сообщений клиент -> сервер (ClientMessage.type).
const MSG_HELLO: String = "hello"
const MSG_PING: String = "ping"
const MSG_ACTION_REQUEST: String = "action.request"
const MSG_QR_SCAN: String = "qr.scan"
const MSG_PHONE_UI: String = "phone.ui"
## Все типы сообщений клиент -> сервер.
const CLIENT_MESSAGE_TYPES: Array[String] = [
	MSG_HELLO,
	MSG_PING,
	MSG_ACTION_REQUEST,
	MSG_QR_SCAN,
	MSG_PHONE_UI,
]

# Типы сообщений сервер -> клиент (ServerMessage.type).
const MSG_WELCOME: String = "welcome"
const MSG_PONG: String = "pong"
const MSG_VIEW_UPDATE: String = "view.update"
const MSG_EVENT: String = "event"
const MSG_ACTION_RESULT: String = "action.result"
const MSG_QR_RESULT: String = "qr.result"
const MSG_RESYNC: String = "resync"
const MSG_ERROR: String = "error"
const MSG_PEER_STATUS: String = "peer.status"
## Все типы сообщений сервер -> клиент.
const SERVER_MESSAGE_TYPES: Array[String] = [
	MSG_WELCOME,
	MSG_PONG,
	MSG_VIEW_UPDATE,
	MSG_EVENT,
	MSG_ACTION_RESULT,
	MSG_QR_RESULT,
	MSG_RESYNC,
	MSG_ERROR,
	MSG_PEER_STATUS,
]

# Типы событий в сообщении `event` (ClientEvent.type).
const EVENT_NOTIFICATION: String = "notification"
const EVENT_INCOMING_CALL: String = "incomingCall"
const EVENT_SCAN_RESULT: String = "scanResult"
const EVENT_GAME_OVER: String = "gameOver"
## Все типы событий.
const EVENT_TYPES: Array[String] = [
	EVENT_NOTIFICATION,
	EVENT_INCOMING_CALL,
	EVENT_SCAN_RESULT,
	EVENT_GAME_OVER,
]

# Коды ошибок (ErrorCode).
const ERROR_INVALID_MESSAGE: String = "INVALID_MESSAGE"
const ERROR_UNAUTHORIZED: String = "UNAUTHORIZED"
const ERROR_PROTOCOL_MISMATCH: String = "PROTOCOL_MISMATCH"
const ERROR_SESSION_NOT_FOUND: String = "SESSION_NOT_FOUND"
const ERROR_SESSION_CLOSED: String = "SESSION_CLOSED"
const ERROR_SCENARIO_NOT_FOUND: String = "SCENARIO_NOT_FOUND"
const ERROR_PAIRING_CODE_INVALID: String = "PAIRING_CODE_INVALID"
const ERROR_PAIRING_CODE_EXPIRED: String = "PAIRING_CODE_EXPIRED"
const ERROR_PAIRING_RATE_LIMITED: String = "PAIRING_RATE_LIMITED"
const ERROR_DEVICE_REVOKED: String = "DEVICE_REVOKED"
const ERROR_ACTION_INVALID: String = "ACTION_INVALID"
const ERROR_ACTION_NOT_AVAILABLE: String = "ACTION_NOT_AVAILABLE"
const ERROR_ACTION_BLOCKED: String = "ACTION_BLOCKED"
const ERROR_GAME_OVER: String = "GAME_OVER"
const ERROR_QR_INVALID: String = "QR_INVALID"
const ERROR_QR_WRONG_SESSION: String = "QR_WRONG_SESSION"
const ERROR_QR_EXPIRED: String = "QR_EXPIRED"
const ERROR_QR_ALREADY_USED: String = "QR_ALREADY_USED"
const ERROR_QR_PRECONDITION_FAILED: String = "QR_PRECONDITION_FAILED"
const ERROR_SAVE_NOT_FOUND: String = "SAVE_NOT_FOUND"
const ERROR_SAVE_DESYNC: String = "SAVE_DESYNC"
const ERROR_GENERATION_UNSOLVABLE: String = "GENERATION_UNSOLVABLE"
const ERROR_RATE_LIMITED: String = "RATE_LIMITED"
const ERROR_INTERNAL: String = "INTERNAL"
## Все коды ошибок.
const ERROR_CODES: Array[String] = [
	ERROR_INVALID_MESSAGE,
	ERROR_UNAUTHORIZED,
	ERROR_PROTOCOL_MISMATCH,
	ERROR_SESSION_NOT_FOUND,
	ERROR_SESSION_CLOSED,
	ERROR_SCENARIO_NOT_FOUND,
	ERROR_PAIRING_CODE_INVALID,
	ERROR_PAIRING_CODE_EXPIRED,
	ERROR_PAIRING_RATE_LIMITED,
	ERROR_DEVICE_REVOKED,
	ERROR_ACTION_INVALID,
	ERROR_ACTION_NOT_AVAILABLE,
	ERROR_ACTION_BLOCKED,
	ERROR_GAME_OVER,
	ERROR_QR_INVALID,
	ERROR_QR_WRONG_SESSION,
	ERROR_QR_EXPIRED,
	ERROR_QR_ALREADY_USED,
	ERROR_QR_PRECONDITION_FAILED,
	ERROR_SAVE_NOT_FOUND,
	ERROR_SAVE_DESYNC,
	ERROR_GENERATION_UNSOLVABLE,
	ERROR_RATE_LIMITED,
	ERROR_INTERNAL,
]

# Роли подключений (ключи ACTIONS_BY_ROLE).
const ROLE_DESKTOP: String = "desktop"
const ROLE_PHONE: String = "phone"
## Все роли.
const ROLES: Array[String] = [
	ROLE_DESKTOP,
	ROLE_PHONE,
]

# Типы действий игрока (PlayerAction.type).
const ACTION_MOVE: String = "move"
const ACTION_EXAMINE_LOCATION: String = "examineLocation"
const ACTION_EXAMINE_HOTSPOT: String = "examineHotspot"
const ACTION_TALK: String = "talk"
const ACTION_INTERROGATE: String = "interrogate"
const ACTION_READ: String = "read"
const ACTION_USE_ITEM: String = "useItem"
const ACTION_PICK_LOCK: String = "pickLock"
const ACTION_REST: String = "rest"
const ACTION_WAIT: String = "wait"
const ACTION_ACCUSE: String = "accuse"
const ACTION_MARK_SUSPICION: String = "markSuspicion"
const ACTION_CALL: String = "call"
const ACTION_ANSWER_CALL: String = "answerCall"
const ACTION_CALL_CHOICE: String = "callChoice"
const ACTION_MESSAGE: String = "message"
const ACTION_BROWSE: String = "browse"
const ACTION_OPEN_FILE: String = "openFile"
const ACTION_UNLOCK_FILE: String = "unlockFile"
const ACTION_ADD_NOTE: String = "addNote"
const ACTION_CAPTURE_EVIDENCE: String = "captureEvidence"
## Все типы действий, включая отправляемые только сервером.
const ACTION_TYPES: Array[String] = [
	ACTION_MOVE,
	ACTION_EXAMINE_LOCATION,
	ACTION_EXAMINE_HOTSPOT,
	ACTION_TALK,
	ACTION_INTERROGATE,
	ACTION_READ,
	ACTION_USE_ITEM,
	ACTION_PICK_LOCK,
	ACTION_REST,
	ACTION_WAIT,
	ACTION_ACCUSE,
	ACTION_MARK_SUSPICION,
	ACTION_CALL,
	ACTION_ANSWER_CALL,
	ACTION_CALL_CHOICE,
	ACTION_MESSAGE,
	ACTION_BROWSE,
	ACTION_OPEN_FILE,
	ACTION_UNLOCK_FILE,
	ACTION_ADD_NOTE,
	ACTION_CAPTURE_EVIDENCE,
]

# Действия, которые может запросить каждая роль (ACTIONS_BY_ROLE).
const DESKTOP_ACTIONS: Array[String] = [
	ACTION_MOVE,
	ACTION_EXAMINE_LOCATION,
	ACTION_EXAMINE_HOTSPOT,
	ACTION_TALK,
	ACTION_INTERROGATE,
	ACTION_READ,
	ACTION_USE_ITEM,
	ACTION_PICK_LOCK,
	ACTION_REST,
	ACTION_WAIT,
	ACTION_ACCUSE,
	ACTION_MARK_SUSPICION,
]
const PHONE_ACTIONS: Array[String] = [
	ACTION_CALL,
	ACTION_ANSWER_CALL,
	ACTION_CALL_CHOICE,
	ACTION_MESSAGE,
	ACTION_BROWSE,
	ACTION_OPEN_FILE,
	ACTION_UNLOCK_FILE,
	ACTION_ADD_NOTE,
]
## Роль -> Array[String] разрешённых ей действий.
const ACTIONS_BY_ROLE: Dictionary = {
	ROLE_DESKTOP: DESKTOP_ACTIONS,
	ROLE_PHONE: PHONE_ACTIONS,
}
