extends GutTest
## Pairing against a recording Backend and a real GameStore: the server QR as a texture, REST
## failures and retries, the code refresh on expiry (by the clock and by the server), the LAN
## addresses, the phone status from `peer.status`, the start condition and session changes.

const Pairing = preload("res://src/scenes/pairing/pairing.gd")
const Scene = preload("res://src/scenes/pairing/pairing.tscn")
const Format = preload("res://src/scenes/pairing/pairing_format.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const FakeSessionBackend = preload("res://tests/unit/support/fake_session_backend.gd")
const FakeRouter = preload("res://tests/unit/support/fake_router.gd")

const ORIGIN: String = "http://127.0.0.1:7420"
const SESSION_ID: String = "49a4ae5c-4174-416f-94c5-b8a7380636e5"
const OTHER_SESSION_ID: String = "0b0f6a4e-0000-4000-8000-000000000000"
const TOKEN: String = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
const NOW: int = 1_795_683_000_000
const TTL: int = 300_000
const QR_ROUTE: String = "/pairing-qr"
const CODE_ROUTE: String = "/pairing-code"
const NETWORK_ROUTE: String = "/api/v1/network"

var backend: FakeSessionBackend
var store: GameStoreScript
var router: FakeRouter
var screen: Pairing
var session: PairingSession
var now: int = NOW
var matrix: Dictionary


func before_each() -> void:
	now = NOW
	backend = FakeSessionBackend.new()
	add_child_autofree(backend)
	store = GameStoreScript.new()
	add_child_autofree(store)
	store.bind_backend(backend)
	router = FakeRouter.new()
	add_child_autofree(router)
	matrix = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/pairing_qr.json")) as Dictionary
	session = _session("192.168.1.20", "K7M2QX", NOW + TTL)
	PairingSession.set_current(session)
	# NewGame opened the desktop connection of the session before routing here.
	backend.connect_session(session.ws_url(), session.desktop_token())


func after_each() -> void:
	PairingSession.clear()


static func _pairing(host: String, code: String, expires_at: int) -> Dictionary:
	return {"code": code, "expiresAt": float(expires_at), "qrPayload": "hs1:pair:%s:7420:%s" % [host, code]}


func _session(host: String, code: String, expires_at: int, id: String = SESSION_ID) -> PairingSession:
	return PairingSession.from_response(ORIGIN, {
		"sessionId": id, "desktopToken": TOKEN, "pairing": _pairing(host, code, expires_at),
	})


func _open() -> Pairing:
	screen = Scene.instantiate() as Pairing
	screen.bind_sources(backend, store, router)
	screen.clock = func() -> int: return now
	add_child_autofree(screen)
	return screen


func _node(node_name: String) -> Control:
	return screen.find_child(node_name, true, false) as Control


func _text(node_name: String) -> String:
	return (_node(node_name) as Label).text


func _button(node_name: String) -> Button:
	return _node(node_name) as Button


func _last(route: String) -> FakeSessionBackend.Call:
	var found: Array[FakeSessionBackend.Call] = backend.calls_to(route)
	return found.back() if not found.is_empty() else null


func _answer_qr(status: int, body: Variant, result: int = HTTPRequest.RESULT_SUCCESS) -> void:
	backend.answer(_last(QR_ROUTE).id, status, body, result)


static func _error(code: String) -> Dictionary:
	return {"error": {"code": code, "message": "m"}}


func _visible_texts(node: Node) -> PackedStringArray:
	var texts: PackedStringArray = []
	if node is Label:
		texts.append((node as Label).text)
	elif node is OptionButton:
		var option: OptionButton = node
		for index: int in range(option.item_count):
			texts.append(option.get_item_text(index))
	elif node is Button:
		texts.append((node as Button).text)
	for child: Node in node.get_children():
		texts.append_array(_visible_texts(child))
	return texts


func _go_online(phone: String) -> void:
	backend.welcome(SESSION_ID)
	backend.peer_status("online", phone)


# --- QR --------------------------------------------------------------------------------------


func test_opening_requests_the_qr_with_the_desktop_token_and_shows_the_code() -> void:
	_open()
	var qr: FakeSessionBackend.Call = _last(QR_ROUTE)
	assert_eq(qr.url, ORIGIN + "/api/v1/sessions/" + SESSION_ID + "/pairing-qr")
	assert_eq(qr.method, HTTPClient.METHOD_GET)
	assert_eq(qr.token, TOKEN)
	var network: FakeSessionBackend.Call = _last(NETWORK_ROUTE)
	assert_eq(network.url, ORIGIN + NETWORK_ROUTE)
	assert_eq(network.token, "", "the address list needs no credentials")
	assert_eq(_text("Code"), "K7M2QX")
	assert_eq(_text("Expiry"), "Код действует ещё 5:00")
	assert_eq(_text("Address"), "192.168.1.20:7420")
	assert_eq(_text("QrStatus"), Pairing.QR_LOADING)
	assert_false(_node("Qr").visible)
	assert_true(_button("Start").disabled)


func test_the_server_matrix_is_drawn_unfiltered_at_a_whole_scale() -> void:
	_open()
	_answer_qr(200, matrix)
	var rect: TextureRect = _node("Qr") as TextureRect
	assert_eq(screen.get_qr_state(), Format.QR_SHOWN)
	assert_true(rect.visible)
	assert_not_null(rect.texture)
	assert_eq(rect.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_eq(rect.stretch_mode, TextureRect.STRETCH_SCALE)
	var width: int = rect.texture.get_width()
	assert_eq(width, (matrix["size"] as int) + 8)
	assert_eq(rect.custom_minimum_size, Vector2(518, 518), "14 screen pixels per module on 1080p")
	assert_eq(int(rect.custom_minimum_size.x) % width, 0)
	assert_eq(_text("QrStatus"), Pairing.QR_SHOWN_TEXT)


func test_a_malformed_matrix_or_a_network_failure_can_be_retried() -> void:
	_open()
	_answer_qr(200, {"size": 21, "modules": "1"})
	assert_eq(screen.get_qr_state(), Format.QR_FAILED)
	assert_eq(_text("QrStatus"), Pairing.QR_FAILED_TEXT)
	assert_false(_node("Qr").visible)
	assert_true(_button("Retry").visible)
	_button("Retry").pressed.emit()
	assert_eq(backend.calls_to(QR_ROUTE).size(), 2)
	assert_true(_button("Retry").disabled, "one QR request at a time")
	_answer_qr(0, null, HTTPRequest.RESULT_CANT_CONNECT)
	assert_eq(_text("QrStatus"), Pairing.QR_NETWORK_TEXT)
	_button("Retry").pressed.emit()
	_answer_qr(200, matrix)
	assert_true(_node("Qr").visible)
	assert_false(_button("Retry").visible)


func test_a_server_without_the_qr_route_still_offers_the_code_and_address() -> void:
	_open()
	_answer_qr(404, {"message": "Route GET:/x not found", "error": "Not Found", "statusCode": 404})
	assert_eq(screen.get_qr_state(), Format.QR_UNAVAILABLE)
	assert_eq(_text("QrStatus"), Pairing.QR_UNAVAILABLE_TEXT)
	assert_eq(_text("Code"), "K7M2QX")
	assert_eq(_text("Address"), "192.168.1.20:7420")
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 0, "no new code for a missing route")


# --- code refresh -----------------------------------------------------------------------------


func test_a_code_the_server_calls_expired_is_replaced_once() -> void:
	_open()
	_answer_qr(410, _error("PAIRING_CODE_EXPIRED"))
	var code: FakeSessionBackend.Call = _last(CODE_ROUTE)
	assert_not_null(code)
	assert_eq(code.url, ORIGIN + "/api/v1/sessions/" + SESSION_ID + "/pairing-code")
	assert_eq(code.method, HTTPClient.METHOD_POST)
	assert_eq(code.token, TOKEN)
	assert_eq(str(backend.bodies[code.id]), "", "the route takes no body")
	assert_eq(_text("QrStatus"), Pairing.QR_REFRESHING)
	backend.answer(code.id, 200, _pairing("192.168.1.20", "ZZ9Y8X", NOW + TTL))
	assert_eq(_text("Code"), "ZZ9Y8X")
	assert_eq(session.code, "ZZ9Y8X")
	assert_eq(backend.calls_to(QR_ROUTE).size(), 2, "the QR of the new code is requested")
	# The server still calls it expired (its clock is ahead): the player decides now.
	_answer_qr(410, _error("PAIRING_CODE_EXPIRED"))
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 1)
	assert_eq(_text("QrStatus"), Pairing.QR_EXPIRED_TEXT)
	_button("NewCode").pressed.emit()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 2)


func test_the_clock_replaces_an_expired_code_once_per_code() -> void:
	_open()
	_answer_qr(200, matrix)
	now = NOW + TTL - 1
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 0)
	assert_eq(_text("Expiry"), "Код действует ещё 0:01")
	now = NOW + TTL
	screen.tick()
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 1, "one replacement in flight")
	backend.answer(_last(CODE_ROUTE).id, 0, null, HTTPRequest.RESULT_CANT_CONNECT)
	assert_eq(_text("QrStatus"), Pairing.QR_NETWORK_TEXT)
	now += 60_000
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 1, "a failed replacement is not repeated on its own")
	assert_eq(_text("Expiry"), "Срок действия кода истёк")
	_button("NewCode").pressed.emit()
	backend.answer(_last(CODE_ROUTE).id, 200, _pairing("192.168.1.20", "ZZ9Y8X", now + TTL))
	assert_eq(_text("Code"), "ZZ9Y8X")
	assert_eq(_text("Expiry"), "Код действует ещё 5:00")
	now += TTL
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 3, "the next code is replaced on expiry again")


func test_a_code_already_expired_by_our_clock_is_not_replaced_in_a_loop() -> void:
	PairingSession.set_current(null)
	session = _session("192.168.1.20", "K7M2QX", NOW - 1)
	PairingSession.set_current(session)
	_open()
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 0)


func test_new_code_is_one_request_at_a_time() -> void:
	_open()
	_button("NewCode").pressed.emit()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 1)
	screen.request_new_code()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 1)
	assert_true(_last(QR_ROUTE).id in backend.canceled, "the old QR request is dropped")


func test_a_malformed_new_code_keeps_the_current_one() -> void:
	_open()
	screen.request_new_code()
	backend.answer(_last(CODE_ROUTE).id, 200, {"code": "bad"})
	assert_eq(screen.get_qr_state(), Format.QR_FAILED)
	assert_eq(_text("Code"), "K7M2QX")


func test_a_session_the_server_forgot_is_reported() -> void:
	_open()
	screen.request_new_code()
	backend.answer(_last(CODE_ROUTE).id, 404, _error("SESSION_NOT_FOUND"))
	assert_eq(_text("Error"), Pairing.SESSION_LOST_TEXT)
	assert_false(_node("Code").is_visible_in_tree())
	assert_false(_button("Back").disabled)


# --- addresses --------------------------------------------------------------------------------


func test_lan_candidates_can_be_chosen_for_manual_entry() -> void:
	_open()
	var choice: OptionButton = _node("AddressChoice") as OptionButton
	assert_false(choice.visible, "one address: nothing to choose")
	backend.answer(_last(NETWORK_ROUTE).id, 200, {"candidates": [
		{"address": "192.168.1.20", "interface": "Wi-Fi", "recommended": true, "virtual": false},
		{"address": "10.0.0.7", "interface": "Ethernet", "recommended": false, "virtual": false},
		{"address": "172.17.0.1", "interface": "docker0", "recommended": false, "virtual": true},
	]})
	assert_true(choice.visible)
	assert_eq(choice.item_count, 3)
	assert_eq(choice.get_item_text(0), "192.168.1.20:7420 — Wi-Fi, рекомендуется, в QR")
	assert_false(_node("AddressHint").visible)
	choice.select(1)
	choice.item_selected.emit(1)
	assert_eq(_text("Address"), "10.0.0.7:7420")
	assert_eq(_text("AddressHint"), Pairing.ADDRESS_OTHER_HINT % "192.168.1.20:7420")
	assert_eq(_text("Code"), "K7M2QX", "the code is the same for every address")


func test_a_loopback_qr_address_is_flagged() -> void:
	PairingSession.set_current(null)
	session = _session("127.0.0.1", "K7M2QX", NOW + TTL)
	PairingSession.set_current(session)
	_open()
	assert_true(_node("AddressHint").visible)
	assert_eq(_text("AddressHint"), Pairing.LOCAL_ONLY_HINT % "127.0.0.1")


func test_a_failed_address_list_keeps_the_qr_address() -> void:
	_open()
	backend.answer(_last(NETWORK_ROUTE).id, 0, null, HTTPRequest.RESULT_CANT_CONNECT)
	assert_eq(_text("Address"), "192.168.1.20:7420")
	assert_eq(_text("Error"), "")


# --- phone status and start -------------------------------------------------------------------


func test_start_waits_for_a_server_confirmed_online_phone() -> void:
	_open()
	var start: Button = _button("Start")
	assert_eq(_text("Connection"), Format.connection_text(FakeSessionBackend.ConnectionState.CONNECTING))
	assert_eq(_text("Phone"), Format.PHONE_UNKNOWN_TEXT)
	assert_true(start.disabled)
	backend.welcome(SESSION_ID)
	assert_eq(_text("Connection"), "Игра подключена к серверу")
	assert_true(start.disabled, "no peer.status yet")
	assert_true(_node("StartHint").visible)
	backend.peer_status("online", "unpaired")
	assert_eq(_text("Phone"), "Телефон не привязан")
	assert_true(start.disabled)
	backend.peer_status("online", "online")
	assert_eq(_text("Phone"), "Телефон в сети")
	assert_false(start.disabled)
	assert_false(_node("StartHint").visible)
	start.pressed.emit()
	assert_eq(router.last_screen(), Pairing.START_SCREEN)
	backend.peer_status("online", "offline")
	assert_eq(_text("Phone"), "Телефон привязан, но не в сети")
	assert_true(start.disabled)
	assert_eq(screen.start_investigation(), ERR_UNAVAILABLE)
	assert_eq(router.routes.size(), 1)


func test_a_lost_connection_disables_start_even_with_an_online_phone() -> void:
	_open()
	_go_online("online")
	assert_false(_button("Start").disabled)
	backend._set_state(FakeSessionBackend.ConnectionState.RETRYING)
	assert_true(_button("Start").disabled)
	assert_eq(_text("Connection"), "Связь с сервером потеряна, переподключаемся…")


func test_a_paired_phone_hides_the_qr_and_stops_code_refresh() -> void:
	_open()
	_answer_qr(200, matrix)
	_go_online("online")
	assert_eq(_text("QrStatus"), Pairing.PAIRED_TEXT)
	assert_false(_node("Qr").visible)
	assert_false(_node("Code").is_visible_in_tree())
	now = NOW + TTL + 1
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 0)
	backend.peer_status("online", "unpaired")
	assert_true(_node("Qr").visible, "a revoked phone needs the QR again")


func test_new_code_over_a_paired_phone_shows_the_code_and_qr() -> void:
	_open()
	_answer_qr(200, matrix)
	_go_online("online")
	assert_false(_node("Qr").visible)
	assert_false(screen.is_repairing())
	assert_true(_node("NewCode").visible)
	assert_true(_text("PhoneHint").contains("Новый код"))
	_button("NewCode").pressed.emit()
	assert_true(screen.is_repairing())
	backend.answer(_last(CODE_ROUTE).id, 200, _pairing("192.168.1.20", "ZZ9Y8X", NOW + TTL))
	_answer_qr(200, matrix)
	assert_eq(_text("Code"), "ZZ9Y8X")
	assert_true(_node("Code").is_visible_in_tree())
	assert_true(_node("Qr").visible)
	assert_eq(_text("QrStatus"), Pairing.REPAIR_SHOWN_TEXT)
	assert_eq(_text("Phone"), "Телефон в сети", "the phone status stays visible")
	# The code is still replaced on expiry while the phone is being replaced.
	now = NOW + TTL + 1
	screen.tick()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 2)


func test_replacement_mode_ends_when_a_phone_comes_online_again() -> void:
	_open()
	_answer_qr(200, matrix)
	_go_online("offline")
	assert_eq(_text("Phone"), Format.phone_text("offline"))
	assert_true(_text("PhoneHint").contains("не на связи"))
	assert_false(_node("Code").is_visible_in_tree())
	screen.request_new_code()
	backend.answer(_last(CODE_ROUTE).id, 200, _pairing("192.168.1.20", "ZZ9Y8X", NOW + TTL))
	_answer_qr(200, matrix)
	assert_true(_node("Code").is_visible_in_tree())
	assert_true(_node("Qr").visible)
	backend.peer_status("online", "unpaired")
	assert_true(screen.is_repairing(), "the old phone was revoked, the new one has not paired yet")
	assert_true(_node("Qr").visible)
	backend.peer_status("online", "online")
	assert_false(screen.is_repairing())
	assert_eq(_text("QrStatus"), Pairing.PAIRED_TEXT)
	assert_false(_node("Qr").visible)
	assert_false(_node("Code").is_visible_in_tree())


func test_new_code_without_a_paired_phone_is_not_replacement_mode() -> void:
	_open()
	_answer_qr(200, matrix)
	_go_online("unpaired")
	screen.request_new_code()
	assert_false(screen.is_repairing())
	assert_true(_text("PhoneHint").is_empty())


func test_a_rejected_handshake_can_be_retried() -> void:
	_open()
	backend._set_state(FakeSessionBackend.ConnectionState.HANDSHAKING)
	backend._receive(JSON.stringify({
		"v": ProtocolConstants.PROTOCOL_VERSION, "type": ProtocolConstants.MSG_ERROR, "id": "e",
		"payload": {"code": "UNAUTHORIZED", "message": "Invalid token"},
	}).to_utf8_buffer())
	assert_eq(store.get_connection_state(), FakeSessionBackend.ConnectionState.OFFLINE)
	assert_eq(_text("Error"), Pairing.REJECTED_TEXT % "UNAUTHORIZED")
	var reconnect: Button = _button("Reconnect")
	assert_true(reconnect.visible)
	reconnect.pressed.emit()
	assert_eq(backend.connects.size(), 2)
	assert_eq(backend.connects[1], {"url": "ws://127.0.0.1:7420/ws", "token": TOKEN})
	assert_eq(_text("Error"), "")
	assert_true(_button("Start").disabled)


# --- session changes --------------------------------------------------------------------------


func test_a_connection_to_another_session_blocks_start() -> void:
	_open()
	backend.welcome(OTHER_SESSION_ID)
	backend.peer_status("online", "online")
	assert_eq(_text("Error"), Pairing.SESSION_CHANGED_TEXT)
	assert_true(_button("Start").disabled)
	assert_false(_node("Code").is_visible_in_tree())
	assert_eq(_text("Phone"), Format.PHONE_UNKNOWN_TEXT, "another session's phone is not ours")


func test_a_replaced_pairing_session_ignores_late_answers() -> void:
	_open()
	var other: PairingSession = _session("10.0.0.7", "ZZ9Y8X", NOW + TTL, OTHER_SESSION_ID)
	PairingSession.set_current(other)
	_answer_qr(200, matrix)
	screen.tick()
	assert_eq(screen.get_qr_state(), "loading", "the answer belongs to the old session")
	assert_eq(_text("Error"), Pairing.SESSION_CHANGED_TEXT)
	screen.request_new_code()
	assert_eq(backend.calls_to(CODE_ROUTE).size(), 0)
	_go_online("online")
	assert_true(_button("Start").disabled)


func test_back_leaves_the_session() -> void:
	_open()
	var qr: int = _last(QR_ROUTE).id
	_button("Back").pressed.emit()
	assert_eq(backend.disconnects, 1)
	assert_null(PairingSession.current())
	assert_has(backend.canceled, qr)
	assert_eq(router.last_screen(), Pairing.BACK_SCREEN)
	assert_eq(store.get_connection_state(), FakeSessionBackend.ConnectionState.OFFLINE)


func test_without_a_session_only_back_is_offered() -> void:
	PairingSession.clear()
	_open()
	assert_eq(backend.calls.size(), 0)
	assert_eq(_text("Error"), Pairing.NO_SESSION_TEXT)
	assert_true(_button("Start").disabled)
	_button("Back").pressed.emit()
	assert_eq(router.last_screen(), Pairing.BACK_SCREEN)
	assert_eq(backend.disconnects, 0, "nothing of another screen is closed")


func test_the_token_is_never_shown() -> void:
	_open()
	_answer_qr(200, matrix)
	backend.answer(_last(NETWORK_ROUTE).id, 200, {"candidates": [
		{"address": "10.0.0.7", "interface": "Ethernet", "recommended": false, "virtual": false},
	]})
	_go_online("online")
	for text: String in _visible_texts(screen):
		assert_false(text.contains(TOKEN))
