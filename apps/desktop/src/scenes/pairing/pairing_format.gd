extends RefCounted
## Pairing data rules without a scene: QR answer classes, the LAN address list, the code
## countdown, peer status text and the start condition (backend.md §3, protocol.md §7).

const BackendScript = preload("res://src/autoload/backend.gd")
const NewGameFormat = preload("res://src/scenes/new_game/new_game_format.gd")

## Outcomes of `GET /sessions/:id/pairing-qr` and `POST /sessions/:id/pairing-code`.
const QR_SHOWN: String = "shown"
const QR_EXPIRED: String = "expired"
const QR_NO_CODE: String = "no_code"
const QR_UNAVAILABLE: String = "unavailable"
const QR_SESSION_LOST: String = "session_lost"
const QR_NETWORK: String = "network"
const QR_FAILED: String = "failed"

const PHONE_ONLINE: String = "online"
const PHONE_OFFLINE: String = "offline"
const PHONE_UNPAIRED: String = "unpaired"

const PHONE_TEXT: Dictionary = {
	"online": "Телефон в сети",
	"offline": "Телефон привязан, но не в сети",
	"unpaired": "Телефон не привязан",
}
const PHONE_HINTS: Dictionary = {
	"offline": "Телефон уже привязан к этой игре, но сейчас не на связи (закрыто приложение или нет Wi-Fi). Чтобы привязать другой телефон или переустановленное приложение, нажмите «Новый код».",
	"online": "Чтобы заменить телефон, нажмите «Новый код»: привязка по новому коду заменит текущий телефон.",
}
const PHONE_UNKNOWN_TEXT: String = "Статус телефона пока неизвестен"
const CONNECTION_TEXT: Dictionary = {
	BackendScript.ConnectionState.OFFLINE: "Игра не подключена к серверу",
	BackendScript.ConnectionState.CONNECTING: "Подключение игры к серверу…",
	BackendScript.ConnectionState.HANDSHAKING: "Подключение игры к серверу…",
	BackendScript.ConnectionState.ONLINE: "Игра подключена к серверу",
	BackendScript.ConnectionState.RETRYING: "Связь с сервером потеряна, переподключаемся…",
}


## The class of a pairing-qr or pairing-code answer. A 404 without the protocol error format
## means the server has no such route ([constant QR_UNAVAILABLE]).
static func classify(result: int, status: int, body: Variant) -> String:
	if result != HTTPRequest.RESULT_SUCCESS:
		return QR_NETWORK
	var code: String = NewGameFormat.error_code(body)
	if status == 200:
		return QR_SHOWN
	if status == 410 and code == "PAIRING_CODE_EXPIRED":
		return QR_EXPIRED
	if status == 404 and code == "PAIRING_CODE_INVALID":
		return QR_NO_CODE
	if (status == 404 and code == "SESSION_NOT_FOUND") or (status == 401 and code == "UNAUTHORIZED"):
		return QR_SESSION_LOST
	if (status == 404 and code.is_empty()) or status == 501:
		return QR_UNAVAILABLE
	return QR_FAILED


## Addresses the phone can be given by hand: first the QR host, then other `GET /network`
## candidates in server order. Each entry: `{address, interface, recommended, virtual, in_qr}`.
static func address_options(qr_host: String, network: Variant) -> Array[Dictionary]:
	var options: Array[Dictionary] = [
		{"address": qr_host, "interface": "", "recommended": false, "virtual": false, "in_qr": true},
	]
	var candidates: Variant = (network as Dictionary).get("candidates") if network is Dictionary else null
	if not candidates is Array:
		return options
	for item: Variant in candidates as Array:
		if not item is Dictionary:
			continue
		var candidate: Dictionary = item
		var address: Variant = candidate.get("address")
		if not address is String or not _is_host(address as String):
			continue
		var entry: Dictionary = {
			"address": address,
			"interface": str(candidate.get("interface", "")) if candidate.get("interface") is String else "",
			"recommended": candidate.get("recommended") == true,
			"virtual": candidate.get("virtual") == true,
			"in_qr": address == qr_host,
		}
		var known: int = options.find_custom(func(option: Dictionary) -> bool: return option["address"] == address)
		if known >= 0:
			entry["in_qr"] = options[known]["in_qr"]
			options[known] = entry
		else:
			options.append(entry)
	return options


## "192.168.1.20:7420 — Wi-Fi, рекомендуется, в QR".
static func address_label(option: Dictionary, port: int) -> String:
	var notes: PackedStringArray = []
	if not str(option.get("interface", "")).is_empty():
		notes.append(str(option["interface"]))
	if option.get("recommended") == true:
		notes.append("рекомендуется")
	if option.get("virtual") == true:
		notes.append("виртуальный адрес")
	if option.get("in_qr") == true:
		notes.append("в QR")
	var text: String = "%s:%d" % [str(option.get("address", "")), port]
	return text if notes.is_empty() else "%s — %s" % [text, ", ".join(notes)]


## True for 127.* and localhost: a phone cannot reach the computer by it.
static func is_local_only(host: String) -> bool:
	return host.begins_with("127.") or host.to_lower() == "localhost"


## "Код действует ещё 4:05"; once the time is up, an expiry notice.
static func expiry_text(expires_at: int, now: int) -> String:
	var remaining: int = ceili(float(expires_at - now) / 1000.0)
	if remaining <= 0:
		return "Срок действия кода истёк"
	return "Код действует ещё %d:%02d" % [remaining / 60, remaining % 60]


## The on-screen side of a QR texture: the largest whole multiple of its width that fits
## [param max_side], so every module gets the same number of screen pixels.
static func qr_display_side(texture_side: int, max_side: int) -> int:
	if texture_side <= 0:
		return 0
	return maxi(1, max_side / texture_side) * texture_side


static func phone_text(phone: String) -> String:
	return str(PHONE_TEXT.get(phone, PHONE_UNKNOWN_TEXT))


## Explains what a paired phone's status means and how to replace the phone; empty if unpaired.
static func phone_hint(phone: String) -> String:
	return str(PHONE_HINTS.get(phone, ""))


static func connection_text(state: BackendScript.ConnectionState) -> String:
	return str(CONNECTION_TEXT.get(state, CONNECTION_TEXT[BackendScript.ConnectionState.OFFLINE]))


## A phone that has paired with this session (online or reconnecting).
static func is_paired(phone: String) -> bool:
	return phone == PHONE_ONLINE or phone == PHONE_OFFLINE


## The investigation may start only once the server has confirmed, over this session's live
## desktop connection, that the phone is online.
static func can_start(
	connection: BackendScript.ConnectionState, connected_session: String,
	paired_session: String, phone: String
) -> bool:
	return (
		connection == BackendScript.ConnectionState.ONLINE
		and not paired_session.is_empty()
		and connected_session == paired_session
		and phone == PHONE_ONLINE
	)


static func _is_host(value: String) -> bool:
	return RegEx.create_from_string(r"^[A-Za-z0-9.-]{1,253}\z").search(value) != null
