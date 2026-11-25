extends GutTest

const Envelope = preload("res://src/net/envelope.gd")
const ReconnectPolicy = preload("res://src/net/reconnect_policy.gd")
const BackendScript = preload("res://src/autoload/backend.gd")


func test_cancel_queued_rest_removes_only_the_matching_call() -> void:
	var backend: BackendScript = BackendScript.new()
	add_child_autofree(backend)
	var canceled: int = backend.request_rest("http://127.0.0.1/old")
	var kept: int = backend.request_rest("http://127.0.0.1/current")
	backend.cancel_queued_rest(canceled)
	assert_eq(backend._rest_queue.size(), 1)
	assert_eq(backend._rest_queue[0].id, kept)
	backend.cancel_queued_rest(kept)


func test_reconnect_delay_grows_and_stays_within_maximum() -> void:
	assert_almost_eq(ReconnectPolicy.delay(0, -0.2), 0.4, 0.001)
	assert_almost_eq(ReconnectPolicy.delay(1, 0.2), 1.2, 0.001)
	assert_eq(ReconnectPolicy.delay(3, 0.0), 4.0)
	assert_eq(ReconnectPolicy.delay(20, 0.2), 8.0)


func test_server_envelope_checks_version_type_and_shape() -> void:
	var valid: String = '{"v":1,"type":"pong","id":"s-1","seq":2,"payload":{}}'
	var message: Dictionary = Envelope.parse_server(valid.to_utf8_buffer())
	assert_eq(str(message.get("type")), "pong")
	assert_eq(Envelope.counter(message.get("seq")), 2)
	assert_true(Envelope.parse_server(valid.replace('"seq":2', '"seq":1.5').to_utf8_buffer()).is_empty())
	assert_true(Envelope.parse_server(valid.replace('"seq":2', '"ack":2').to_utf8_buffer()).is_empty())
	assert_true(Envelope.parse_server(valid.replace('"v":1', '"v":2').to_utf8_buffer()).is_empty())
	assert_true(Envelope.parse_server(valid.replace('"pong"', '"ping"').to_utf8_buffer()).is_empty())
	assert_true(Envelope.parse_server(valid.replace('"payload":{}', '"payload":[]').to_utf8_buffer()).is_empty())
