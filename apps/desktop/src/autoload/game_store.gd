extends Node
## GameStore: the single client copy of the PlayerView and the typed signals screens listen to.
##
## Screens never talk to Backend directly: they read the view here, subscribe to the signals below
## and send actions through [method request_action]. The store keeps only what the server sent to
## the desktop role, computes no game rules (ADR 0002) and refuses a view that carries server-only
## truth (AGENTS.md rule 1). Every Dictionary it hands out is a deep read-only copy.

const BackendScript = preload("res://src/autoload/backend.gd")
const Envelope = preload("res://src/net/envelope.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

## A newer PlayerView was accepted. [param view] is read-only.
signal view_changed(view: Dictionary, state_version: int)
## A ClientEvent from an `event` message (notification, incomingCall, scanResult, gameOver).
## [param event] is read-only.
signal event_received(event: Dictionary)
## The presence of the desktop and phone connections from `peer.status` changed.
## Values: "online", "offline", "unpaired" (phone only) or [constant PEER_UNKNOWN].
signal peer_status_changed(desktop: String, phone: String)
## An action was rejected before sending, by `action.result` with `ok: false`, or by an `error`
## that names a request. [param code] is an ErrorCode or [constant ERROR_NOT_CONNECTED].
signal action_failed(code: String, message: String)
## A server `error` that names no request (for example UNAUTHORIZED during the handshake).
signal error_received(code: String, message: String)
## The Backend connection stage changed; OFFLINE also clears the store (the session ended).
signal connection_state_changed(state: BackendScript.ConnectionState)

## Peer status before the first `peer.status` of a session.
const PEER_UNKNOWN: String = "unknown"
## Values of `peer.status` (protocol.md §3; not part of the generated ProtocolConstants).
const DESKTOP_STATUSES: Array[String] = ["online", "offline"]
const PHONE_STATUSES: Array[String] = ["online", "offline", "unpaired"]
## Client-side code for an action that could not be sent because there is no live session.
const ERROR_NOT_CONNECTED: String = "NOT_CONNECTED"
## Keys that must never reach a client view. Mirrors FORBIDDEN_VIEW_KEYS of @hs/protocol
## (packages/protocol/src/views/common.ts); the contract test keeps the two lists equal.
const FORBIDDEN_VIEW_KEYS: Array[String] = ["veracity", "culpritIds", "truth", "hallucination"]

var _backend: BackendScript
var _view: Dictionary = ReadOnly.empty()
var _state_version: int = -1
var _resync_pending: bool = false
var _desktop_status: String = PEER_UNKNOWN
var _phone_status: String = PEER_UNKNOWN
var _connection_state: BackendScript.ConnectionState = BackendScript.ConnectionState.OFFLINE


func _ready() -> void:
	var autoload: Node = get_node_or_null(^"/root/Backend")
	if autoload is BackendScript:
		bind_backend(autoload as BackendScript)


## Listens to [param backend] instead of the current one and clears the store.
## The autoload binds the `Backend` autoload itself; tests pass a fake.
func bind_backend(backend: BackendScript) -> void:
	if _backend != null and is_instance_valid(_backend):
		if _backend.message_received.is_connected(_on_message_received):
			_backend.message_received.disconnect(_on_message_received)
		if _backend.connection_state_changed.is_connected(_on_connection_state_changed):
			_backend.connection_state_changed.disconnect(_on_connection_state_changed)
	_backend = backend
	_connection_state = BackendScript.ConnectionState.OFFLINE
	reset()
	if _backend != null:
		_backend.message_received.connect(_on_message_received)
		_backend.connection_state_changed.connect(_on_connection_state_changed)


## Forgets the view, its version and the peer status (a new session starts from scratch).
func reset() -> void:
	_view = ReadOnly.empty()
	_state_version = -1
	_resync_pending = false
	_set_peer_status(PEER_UNKNOWN, PEER_UNKNOWN)


## The current PlayerView (read-only); empty until the first `view.update`.
func get_view() -> Dictionary:
	return _view


func has_view() -> bool:
	return _state_version >= 0


## stateVersion of the current view; -1 until the first `view.update`.
func get_state_version() -> int:
	return _state_version


func get_desktop_status() -> String:
	return _desktop_status


func get_phone_status() -> String:
	return _phone_status


func get_connection_state() -> BackendScript.ConnectionState:
	return _connection_state


func is_online() -> bool:
	return _connection_state == BackendScript.ConnectionState.ONLINE


## Accepts [param view] if [param state_version] is newer than the current one, stores a read-only
## copy and emits [signal view_changed]. A stale or repeated version is ignored, except for the
## first view after `resync`, which replaces the state whatever its version. Returns true if the
## view was accepted.
func set_view(view: Dictionary, state_version: int) -> bool:
	if state_version < 0 or view.is_empty():
		push_warning("GameStore: view.update without a view or a valid stateVersion ignored")
		return false
	if not _resync_pending and state_version <= _state_version:
		return false
	var leaked: String = find_forbidden_key(view)
	if not leaked.is_empty():
		push_error("GameStore: view rejected, it carries the server-only field '%s'" % leaked)
		return false
	_view = ReadOnly.freeze(view)
	_state_version = state_version
	_resync_pending = false
	view_changed.emit(_view, _state_version)
	return true


## Sends a desktop PlayerAction through Backend. The server decides the outcome: a rejection
## arrives later as [signal action_failed]; a new state arrives as [signal view_changed].
## An action outside the desktop role or without a connection fails at once with
## [signal action_failed] and a non-OK return value.
func request_action(action: Dictionary) -> Error:
	var kind: String = str(action.get("type", ""))
	if not ProtocolConstants.DESKTOP_ACTIONS.has(kind):
		action_failed.emit(
			ProtocolConstants.ERROR_ACTION_INVALID, "Action '%s' is not a desktop action" % kind
		)
		return ERR_INVALID_PARAMETER
	if _backend == null or not is_instance_valid(_backend):
		action_failed.emit(ERROR_NOT_CONNECTED, "Backend is not available")
		return ERR_UNCONFIGURED
	var error: Error = _backend.send_action(action.duplicate(true))
	if error != OK:
		action_failed.emit(ERROR_NOT_CONNECTED, "No live connection to the session server")
	return error


## The first key from [constant FORBIDDEN_VIEW_KEYS] found at any depth of [param value];
## an empty string if there is none.
static func find_forbidden_key(value: Variant) -> String:
	if value is Dictionary:
		var source: Dictionary = value
		for key: Variant in source:
			if FORBIDDEN_VIEW_KEYS.has(str(key)):
				return str(key)
			var nested: String = find_forbidden_key(source[key])
			if not nested.is_empty():
				return nested
	elif value is Array:
		var items: Array = value
		for item: Variant in items:
			var found: String = find_forbidden_key(item)
			if not found.is_empty():
				return found
	return ""


func _on_message_received(message: Dictionary) -> void:
	var raw_payload: Variant = message.get("payload")
	if not raw_payload is Dictionary:
		return
	var payload: Dictionary = raw_payload
	var kind: String = str(message.get("type", ""))
	if kind == ProtocolConstants.MSG_VIEW_UPDATE:
		_on_view_update(payload)
	elif kind == ProtocolConstants.MSG_EVENT:
		_on_event(payload)
	elif kind == ProtocolConstants.MSG_ACTION_RESULT:
		_on_action_result(payload)
	elif kind == ProtocolConstants.MSG_ERROR:
		_on_error(payload)
	elif kind == ProtocolConstants.MSG_PEER_STATUS:
		_on_peer_status(payload)
	elif kind == ProtocolConstants.MSG_RESYNC:
		# The server restarts the state for this role; the snapshot that follows may carry
		# any stateVersion and must replace the current view.
		_resync_pending = true


func _on_view_update(payload: Dictionary) -> void:
	var raw_view: Variant = payload.get("view")
	var version: int = Envelope.counter(payload.get("stateVersion"))
	if not raw_view is Dictionary:
		push_warning("GameStore: view.update without a view ignored")
		return
	set_view(raw_view as Dictionary, version)


func _on_event(payload: Dictionary) -> void:
	var raw_event: Variant = payload.get("event")
	if not raw_event is Dictionary:
		return
	var event: Dictionary = raw_event
	if not ProtocolConstants.EVENT_TYPES.has(str(event.get("type", ""))):
		push_warning("GameStore: event of unknown type ignored")
		return
	event_received.emit(ReadOnly.freeze(event))


func _on_action_result(payload: Dictionary) -> void:
	var ok: Variant = payload.get("ok")
	if not ok is bool or ok as bool:
		return
	action_failed.emit(str(payload.get("error", ProtocolConstants.ERROR_INTERNAL)), "")


func _on_error(payload: Dictionary) -> void:
	var code: String = str(payload.get("code", ProtocolConstants.ERROR_INTERNAL))
	var text: String = str(payload.get("message", ""))
	# Once online the desktop sends only `ping` and `action.request`, so an error that names a
	# request is a rejected action.
	if payload.has("requestId"):
		action_failed.emit(code, text)
	else:
		error_received.emit(code, text)


func _on_peer_status(payload: Dictionary) -> void:
	var desktop: String = str(payload.get("desktop", ""))
	var phone: String = str(payload.get("phone", ""))
	if not DESKTOP_STATUSES.has(desktop) or not PHONE_STATUSES.has(phone):
		push_warning("GameStore: peer.status with unknown values ignored")
		return
	_set_peer_status(desktop, phone)


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == _connection_state:
		return
	_connection_state = state
	if state == BackendScript.ConnectionState.OFFLINE:
		# Backend goes OFFLINE only on disconnect_session(): the session is over or replaced.
		reset()
	connection_state_changed.emit(state)


func _set_peer_status(desktop: String, phone: String) -> void:
	if desktop == _desktop_status and phone == _phone_status:
		return
	_desktop_status = desktop
	_phone_status = phone
	peer_status_changed.emit(desktop, phone)
