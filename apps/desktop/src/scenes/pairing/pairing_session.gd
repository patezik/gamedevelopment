class_name PairingSession
extends RefCounted
## The session this desktop created and pairs a phone with (backend.md §3, protocol.md §7).
##
## NewGame builds it from the `POST /sessions` answer and makes it current; Pairing reads it.
## It holds the desktop token, so it lives only in memory: never in SceneRouter params (every
## screen can read those), never in a file, a label or a log line. [method _to_string] names the
## session only. The seed is not here: the server does not return it (backend.md §3).

const Envelope = preload("res://src/net/envelope.gd")

## Pairing code alphabet of the server: Crockford Base32 in upper case (pairing/index.ts).
const CODE_PATTERN: String = r"^[0-9A-HJKMNP-TV-Z]{6}\z"
const TOKEN_PATTERN: String = r"^[A-Za-z0-9_-]{43}\z"
## `hs1:pair:<host>:<port>:<code>` (ADR 0008); the host is IPv4 or a name.
const PAYLOAD_PATTERN: String = r"^hs1:pair:([A-Za-z0-9.-]+):([0-9]{1,5}):([0-9A-HJKMNP-TV-Z]{6})\z"
const UUID_PATTERN: String = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z"

static var _current: PairingSession = null

## Session Server origin, for example `http://127.0.0.1:7420`.
var origin: String = ""
var session_id: String = ""
## The current pairing code; [member expires_at] is Unix time in ms; host and port come from its QR payload.
var code: String = ""
var expires_at: int = 0
var qr_host: String = ""
var qr_port: int = 0
var _token: String = ""


## The session being paired; null without one.
static func current() -> PairingSession:
	return _current


static func set_current(session: PairingSession) -> void:
	_current = session


## Forgets the current session (Back, a new game, tests).
static func clear() -> void:
	_current = null


## A session from the 201 answer of `POST /sessions`; null if the answer breaks its contract
## (CreateSessionResponse in apps/server/src/routes/sessions.ts).
static func from_response(server_origin: String, body: Variant) -> PairingSession:
	if not body is Dictionary:
		return null
	var data: Dictionary = body
	var id: Variant = data.get("sessionId")
	var token: Variant = data.get("desktopToken")
	if not id is String or not _matches(UUID_PATTERN, id as String):
		return null
	if not token is String or not _matches(TOKEN_PATTERN, token as String):
		return null
	var pairing: Dictionary = parse_pairing(data.get("pairing"))
	if pairing.is_empty():
		return null
	var session: PairingSession = PairingSession.new()
	session.origin = server_origin
	session.session_id = id
	session._token = token
	session.apply_pairing(pairing)
	return session


## `{code, expires_at, host, port}` from a `pairing` object (`POST /sessions`,
## `POST /sessions/:id/pairing-code`); empty if it is malformed or the payload names another code.
static func parse_pairing(value: Variant) -> Dictionary:
	if not value is Dictionary:
		return {}
	var data: Dictionary = value
	var raw_code: Variant = data.get("code")
	var raw_payload: Variant = data.get("qrPayload")
	var expires: int = Envelope.counter(data.get("expiresAt"))
	if not raw_code is String or not raw_payload is String or expires <= 0:
		return {}
	var expression: RegEx = RegEx.create_from_string(PAYLOAD_PATTERN)
	var found: RegExMatch = expression.search(raw_payload as String)
	if found == null or found.get_string(3) != raw_code:
		return {}
	var port: int = found.get_string(2).to_int()
	if port < 1 or port > 65535:
		return {}
	return {"code": raw_code, "expires_at": expires, "host": found.get_string(1), "port": port}


func apply_pairing(pairing: Dictionary) -> void:
	code = str(pairing.get("code", ""))
	expires_at = pairing.get("expires_at", 0) as int
	qr_host = str(pairing.get("host", ""))
	qr_port = pairing.get("port", 0) as int


## The desktop token for the `Authorization` header and `hello`; never shown.
func desktop_token() -> String:
	return _token


## WebSocket address of the gateway (`/ws`) for Backend.connect_session.
func ws_url() -> String:
	if origin.begins_with("https://"):
		return "wss://" + origin.substr(8) + "/ws"
	return "ws://" + origin.trim_prefix("http://") + "/ws"


## `<origin>/api/v1/sessions/<id>/<route>`.
func endpoint(route: String) -> String:
	return "%s/api/v1/sessions/%s/%s" % [origin, session_id.uri_encode(), route]


func _to_string() -> String:
	return "PairingSession(%s)" % session_id


static func _matches(pattern: String, value: String) -> bool:
	return RegEx.create_from_string(pattern).search(value) != null
