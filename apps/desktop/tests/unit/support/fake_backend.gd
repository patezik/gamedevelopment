extends "res://src/autoload/backend.gd"
## Backend test double: records sent actions and lets a test deliver server messages and
## connection stages without a socket.

var sent: Array[Dictionary] = []
var send_result: Error = OK


func send_action(action: Dictionary) -> Error:
	if send_result == OK:
		sent.append(action)
		_last_action_request_id = "desktop-%d" % sent.size()
	return send_result


## Pretends a `welcome` of session [param session_id] arrived.
func set_session_id(session_id: String) -> void:
	_session_id = session_id


func deliver(kind: String, payload: Dictionary) -> void:
	message_received.emit({
		"v": ProtocolConstants.PROTOCOL_VERSION,
		"type": kind,
		"id": "s-test",
		"payload": payload,
	})


func change_state(state: ConnectionState) -> void:
	connection_state_changed.emit(state)
