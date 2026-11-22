extends Node

signal message_received(message: Dictionary)
signal connection_state_changed(state: ConnectionState)
signal rest_completed(request_id: int, result: int, status: int, body: Variant)

enum ConnectionState { OFFLINE, CONNECTING, HANDSHAKING, ONLINE, RETRYING }

const Envelope = preload("res://src/net/envelope.gd")
const ReconnectPolicy = preload("res://src/net/reconnect_policy.gd")
const HEARTBEAT_SECONDS: float = 10.0
const TIMEOUT_SECONDS: float = 30.0

class RestCall:
	var id: int
	var url: String
	var method: HTTPClient.Method
	var headers: PackedStringArray
	var body: String

var _state: ConnectionState = ConnectionState.OFFLINE
var _socket: WebSocketPeer
var _socket_url: String
var _token: String
var _retry: int
var _remaining: float
var _last_received: float
var _heartbeat: float
var _last_seq: int = -1
var _state_version: int
var _request_id: int
var _random: RandomNumberGenerator = RandomNumberGenerator.new()
var _http: HTTPRequest
var _active_rest: RestCall
var _rest_queue: Array[RestCall] = []


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = 10.0
	add_child(_http)
	_http.request_completed.connect(_on_rest_completed)


func request_rest(
	url: String, method: HTTPClient.Method = HTTPClient.METHOD_GET,
	body: String = "", token: String = ""
) -> int:
	_request_id += 1
	var call: RestCall = RestCall.new()
	call.id = _request_id
	call.url = url
	call.method = method
	call.body = body
	call.headers = PackedStringArray(["Accept: application/json"])
	if not body.is_empty():
		call.headers.append("Content-Type: application/json")
	if not token.is_empty():
		call.headers.append("Authorization: Bearer " + token)
	_rest_queue.append(call)
	_start_rest.call_deferred()
	return call.id


func connect_session(url: String, token: String) -> void:
	disconnect_session()
	_socket_url = url
	_token = token
	_open_socket()


func disconnect_session() -> void:
	if _socket != null:
		_socket.close()
	_socket = null
	_socket_url = ""
	_token = ""
	_last_seq = -1
	_state_version = 0
	_retry = 0
	_set_state(ConnectionState.OFFLINE)


func send_action(action: Dictionary) -> Error:
	if _state != ConnectionState.ONLINE:
		return ERR_UNCONFIGURED
	return _send(ProtocolConstants.MSG_ACTION_REQUEST, {"action": action})


func _process(delta: float) -> void:
	if _state == ConnectionState.RETRYING:
		_remaining -= delta
		if _remaining <= 0.0:
			_open_socket()
		return
	if _socket == null:
		return

	_socket.poll()
	_last_received += delta
	if _socket.get_ready_state() == WebSocketPeer.STATE_CLOSED or _last_received >= TIMEOUT_SECONDS:
		_schedule_retry()
		return
	if _socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	if _state == ConnectionState.CONNECTING:
		_set_state(ConnectionState.HANDSHAKING)
		var hello: Dictionary = {
			"role": ProtocolConstants.ROLE_DESKTOP,
			"token": _token,
			"appVersion": str(ProjectSettings.get_setting("application/config/version")),
		}
		if _last_seq >= 0:
			hello["resume"] = {"lastSeq": _last_seq, "stateVersion": _state_version}
		if _send(ProtocolConstants.MSG_HELLO, hello) != OK:
			_schedule_retry()
			return
	while _socket != null and _socket.get_available_packet_count() > 0:
		var packet: PackedByteArray = _socket.get_packet()
		if _socket.was_string_packet():
			_receive(packet)
	if _state == ConnectionState.ONLINE:
		_heartbeat += delta
		if _heartbeat >= HEARTBEAT_SECONDS:
			_heartbeat = 0.0
			if _send(ProtocolConstants.MSG_PING, {}) != OK:
				_schedule_retry()


func _open_socket() -> void:
	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = 512 * 1024
	_last_received = 0.0
	_heartbeat = 0.0
	if _socket.connect_to_url(_socket_url) != OK:
		_schedule_retry()
	else:
		_set_state(ConnectionState.CONNECTING)


func _schedule_retry() -> void:
	if _socket != null:
		_socket.close()
	_socket = null
	_remaining = ReconnectPolicy.delay(_retry, _random.randf_range(-0.2, 0.2))
	_retry = mini(_retry + 1, 4)
	_set_state(ConnectionState.RETRYING)


func _receive(packet: PackedByteArray) -> void:
	var message: Dictionary = Envelope.parse_server(packet)
	if message.is_empty():
		return
	var kind: String = str(message["type"])
	var payload: Dictionary = message["payload"] as Dictionary
	_last_received = 0.0
	if _state == ConnectionState.HANDSHAKING:
		if kind == ProtocolConstants.MSG_ERROR:
			disconnect_session()
			message_received.emit(message)
			return
		if kind != ProtocolConstants.MSG_WELCOME:
			return
		if payload.get("role") != ProtocolConstants.ROLE_DESKTOP:
			return
		if Envelope.counter(payload.get("protocolVersion")) != ProtocolConstants.PROTOCOL_VERSION:
			return
		_retry = 0
		_set_state(ConnectionState.ONLINE)
	var sequence: int = Envelope.counter(message.get("seq"))
	if sequence >= 0 and kind != ProtocolConstants.MSG_WELCOME:
		if sequence <= _last_seq and kind != ProtocolConstants.MSG_RESYNC:
			return
		_last_seq = sequence
	if kind == ProtocolConstants.MSG_VIEW_UPDATE:
		var version: int = Envelope.counter(payload.get("stateVersion"))
		if version >= 0:
			_state_version = version
	if kind == ProtocolConstants.MSG_RESYNC:
		_last_seq = sequence
		_state_version = 0
	message_received.emit(message)


func _send(kind: String, payload: Dictionary) -> Error:
	_request_id += 1
	var message: Dictionary = {
		"v": ProtocolConstants.PROTOCOL_VERSION,
		"type": kind,
		"id": "desktop-%d" % _request_id,
		"payload": payload,
	}
	if _last_seq >= 0:
		message["ack"] = _last_seq
	return _socket.send_text(JSON.stringify(message))


func _set_state(next_state: ConnectionState) -> void:
	if _state != next_state:
		_state = next_state
		connection_state_changed.emit(_state)


func _start_rest() -> void:
	if _active_rest != null or _rest_queue.is_empty():
		return
	_active_rest = _rest_queue.pop_front()
	var error: Error = _http.request(
		_active_rest.url, _active_rest.headers, _active_rest.method, _active_rest.body
	)
	if error != OK:
		_finish_rest(HTTPRequest.RESULT_REQUEST_FAILED, 0, null)


func _on_rest_completed(
	result: int, status: int, _headers: PackedStringArray, bytes: PackedByteArray
) -> void:
	var data: Variant = JSON.parse_string(bytes.get_string_from_utf8()) if not bytes.is_empty() else null
	_finish_rest(result, status, data)


func _finish_rest(result: int, status: int, data: Variant) -> void:
	var request_id: int = _active_rest.id
	_active_rest = null
	rest_completed.emit(request_id, result, status, data)
	_start_rest.call_deferred()
