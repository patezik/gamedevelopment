extends GutTest

const Overlay = preload("res://src/scenes/overlays/evidence_capture/evidence_capture.gd")
const Scene = preload("res://src/scenes/overlays/evidence_capture/evidence_capture.tscn")
const Exploration = preload("res://src/scenes/exploration/exploration.tscn")
const FakeRestBackend = preload("res://tests/unit/support/fake_rest_backend.gd")
const Store = preload("res://src/autoload/game_store.gd")
const TOKEN: String = "AAAAAAAAAAAAAAAA"

var backend: FakeRestBackend
var store: Store
var overlay: Overlay
var matrix: Dictionary


func before_each() -> void:
	backend = FakeRestBackend.new()
	add_child_autofree(backend)
	store = Store.new()
	add_child_autofree(store)
	store.bind_backend(backend)
	# Exercise the real Backend route builder with a received welcome.
	backend._socket_url = "ws://127.0.0.1:7420/ws"
	backend._token = "desktop-credential"
	backend._set_state(FakeRestBackend.ConnectionState.HANDSHAKING)
	backend._receive(JSON.stringify({
		"v": ProtocolConstants.PROTOCOL_VERSION, "type": "welcome", "id": "welcome",
		"payload": {
			"sessionId": "session-id", "role": "desktop",
			"protocolVersion": ProtocolConstants.PROTOCOL_VERSION,
		},
	}).to_utf8_buffer())
	overlay = Scene.instantiate() as Overlay
	overlay.bind_sources(store, backend)
	add_child_autofree(overlay)
	matrix = JSON.parse_string(
		FileAccess.get_file_as_string("res://tests/fixtures/evidence_qr.json")
	) as Dictionary


func test_exploration_contains_hidden_overlay() -> void:
	var exploration: Node = Exploration.instantiate()
	add_child_autofree(exploration)
	var mounted: Overlay = exploration.get_node("EvidenceCapture") as Overlay
	assert_not_null(mounted)
	assert_false((mounted.get_node("%Modal") as Control).visible)


func test_loads_authenticated_matrix_and_draws_every_pixel_with_quiet_zone() -> void:
	_view(1)
	var call: FakeRestBackend.Call = backend.last_call()
	assert_eq(call.url, "http://127.0.0.1:7420/api/v1/sessions/session-id/evidence-qr/" + TOKEN)
	assert_eq(call.token, "desktop-credential")
	assert_eq(call.method, HTTPClient.METHOD_GET)
	assert_eq(_label("%ClueTitle").text, "Запись в журнале")
	assert_true(_label("%PhoneHint").visible)
	backend.answer(call.id, 200, matrix)
	var qr: TextureRect = overlay.get_node("%Qr")
	assert_eq(qr.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	var image: Image = qr.texture.get_image()
	assert_eq(image.get_size(), Vector2i(37, 37))
	var bits: String = matrix["modules"]
	var matches: bool = true
	for y: int in range(37):
		for x: int in range(37):
			var is_dark: bool = x >= 4 and x < 33 and y >= 4 and y < 33 and bits[(y - 4) * 29 + x - 4] == "1"
			matches = matches and image.get_pixel(x, y) == (Color.BLACK if is_dark else Color.WHITE)
	assert_true(matches, "matrix and all four-module white margins")
	backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "online"})
	assert_false(_label("%PhoneHint").visible)
	backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "offline"})
	assert_true(_label("%PhoneHint").visible)


func test_same_token_updates_minutes_without_refetch_and_success_closes() -> void:
	_view(1)
	backend.answer(backend.last_call().id, 200, matrix)
	_view(2, TOKEN, 8)
	assert_string_contains(_label("%Expires").text, "8")
	assert_eq(backend.calls.size(), 1)
	assert_false(store.set_view({"phone": {}}, 1))
	assert_true((overlay.get_node("%Modal") as Control).visible)
	_view(3, "")
	assert_false((overlay.get_node("%Modal") as Control).visible)
	assert_null(_texture())
	_view(4)
	assert_eq(backend.calls.size(), 2)


func test_cancel_and_reopen_ignores_previous_and_replaced_requests() -> void:
	_view(1)
	var canceled: int = backend.last_call().id
	_button("%Cancel").pressed.emit()
	assert_false((overlay.get_node("%Modal") as Control).visible)
	_view(2, TOKEN, 5)
	assert_eq(backend.calls.size(), 1)
	assert_true(_button("%Reopen").visible)
	_button("%Reopen").pressed.emit()
	var replaced: int = backend.last_call().id
	backend.answer(canceled, 200, matrix)
	assert_null(_texture())
	_view(3, "BBBBBBBBBBBBBBBB")
	var current: int = backend.last_call().id
	backend.answer(replaced, 410, {})
	assert_false(_button("%Retry").visible)
	backend.answer(current, 200, matrix)
	assert_not_null(_texture())
	assert_eq(backend.sent.size(), 0, "cancel is local")


func test_errors_can_retry_and_expiry_hides_qr_until_new_view() -> void:
	_view(1)
	backend.answer(backend.last_call().id, 0, null, HTTPRequest.RESULT_TIMEOUT)
	assert_true(_button("%Retry").visible)
	_button("%Retry").pressed.emit()
	backend.answer(backend.last_call().id, 200, {"size": 29, "modules": "bad"})
	assert_true(_button("%Retry").visible)
	assert_null(_texture())
	_button("%Retry").pressed.emit()
	backend.answer(backend.last_call().id, 410, {"error": {"code": "QR_EXPIRED"}})
	assert_string_contains(_label("%Status").text, "истёк")
	assert_false(_button("%Retry").visible)
	_view(2, "")
	assert_false((overlay.get_node("%Modal") as Control).visible)


func test_zero_minutes_and_disconnect_discard_inflight_response() -> void:
	_view(1)
	var request_id: int = backend.last_call().id
	_view(2, TOKEN, 0)
	backend.answer(request_id, 200, matrix)
	assert_null(_texture())
	assert_string_contains(_label("%Status").text, "истёк")
	_view(3, "BBBBBBBBBBBBBBBB")
	request_id = backend.last_call().id
	backend.disconnect_session()
	backend.answer(request_id, 200, matrix)
	assert_false((overlay.get_node("%Modal") as Control).visible)
	assert_null(_texture())
	assert_eq(backend.request_evidence_qr(TOKEN), -1)


func _view(version: int, token: String = TOKEN, minutes: int = 12) -> void:
	var view: Dictionary = {"phone": {"paired": true, "online": false}}
	if not token.is_empty():
		view["pendingCapture"] = {
			"tokenId": token, "clueTitle": "Запись в журнале", "expiresInMinutes": minutes,
		}
	backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": version, "view": view})


func _label(path: String) -> Label:
	return overlay.get_node(path) as Label


func _button(path: String) -> Button:
	return overlay.get_node(path) as Button


func _texture() -> Texture2D:
	var qr: TextureRect = overlay.get_node("%Qr")
	return qr.texture
