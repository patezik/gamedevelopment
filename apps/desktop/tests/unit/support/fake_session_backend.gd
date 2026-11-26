extends "res://tests/unit/support/fake_rest_backend.gd"
## FakeRestBackend that also keeps request bodies and the WebSocket session it was asked to open,
## for the NewGame and Pairing screens. No socket is opened.

## Request bodies by request ID.
var bodies: Dictionary = {}
## Arguments of each connect_session call: [{url, token}].
var connects: Array[Dictionary] = []
var disconnects: int = 0
## IDs passed to cancel_queued_rest.
var canceled: Array[int] = []


func request_rest(
	url: String, method: HTTPClient.Method = HTTPClient.METHOD_GET,
	body: String = "", token: String = ""
) -> int:
	var id: int = super.request_rest(url, method, body, token)
	bodies[id] = body
	return id


func cancel_queued_rest(request_id: int) -> void:
	canceled.append(request_id)


func connect_session(url: String, token: String) -> void:
	connects.append({"url": url, "token": token})
	_socket_url = url
	_token = token
	_set_state(ConnectionState.CONNECTING)


func disconnect_session() -> void:
	disconnects += 1
	super.disconnect_session()


## Calls to [param route] (a URL suffix such as "/pairing-qr"), oldest first.
func calls_to(route: String) -> Array[Call]:
	var found: Array[Call] = []
	for call: Call in calls:
		if call.url.ends_with(route):
			found.append(call)
	return found


## Completes the handshake of the opened session as `welcome` of [param session_id].
func welcome(session_id: String) -> void:
	_set_state(ConnectionState.HANDSHAKING)
	_receive(JSON.stringify({
		"v": ProtocolConstants.PROTOCOL_VERSION, "type": ProtocolConstants.MSG_WELCOME, "id": "w",
		"payload": {
			"sessionId": session_id, "role": ProtocolConstants.ROLE_DESKTOP,
			"protocolVersion": ProtocolConstants.PROTOCOL_VERSION,
		},
	}).to_utf8_buffer())


func peer_status(desktop: String, phone: String) -> void:
	deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": desktop, "phone": phone})
