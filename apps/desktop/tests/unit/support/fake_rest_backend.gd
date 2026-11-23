extends "res://tests/unit/support/fake_backend.gd"
## Backend test double for REST: records request_rest calls instead of sending them and lets a
## test answer a recorded request through rest_completed.

class Call:
	var id: int
	var url: String
	var method: HTTPClient.Method
	var token: String

var calls: Array[Call] = []
var _next_id: int = 100


func request_rest(
	url: String, method: HTTPClient.Method = HTTPClient.METHOD_GET,
	_body: String = "", token: String = ""
) -> int:
	_next_id += 1
	var call: Call = Call.new()
	call.id = _next_id
	call.url = url
	call.method = method
	call.token = token
	calls.append(call)
	return call.id


func last_call() -> Call:
	return calls.back() if not calls.is_empty() else null


func answer(request_id: int, status: int, body: Variant, result: int = HTTPRequest.RESULT_SUCCESS) -> void:
	rest_completed.emit(request_id, result, status, body)
