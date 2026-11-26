extends GutTest

const Format = preload("res://src/scenes/pairing/pairing_format.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const State = BackendScript.ConnectionState
const OK_RESULT: int = HTTPRequest.RESULT_SUCCESS


static func error(code: String) -> Dictionary:
	return {"error": {"code": code, "message": "m"}}


func test_qr_answers_are_classified() -> void:
	assert_eq(Format.classify(OK_RESULT, 200, {"size": 21, "modules": ""}), Format.QR_SHOWN)
	assert_eq(Format.classify(OK_RESULT, 410, error("PAIRING_CODE_EXPIRED")), Format.QR_EXPIRED)
	assert_eq(Format.classify(OK_RESULT, 404, error("PAIRING_CODE_INVALID")), Format.QR_NO_CODE)
	assert_eq(Format.classify(OK_RESULT, 404, error("SESSION_NOT_FOUND")), Format.QR_SESSION_LOST)
	assert_eq(Format.classify(OK_RESULT, 401, error("UNAUTHORIZED")), Format.QR_SESSION_LOST)
	# Fastify's answer for a route the server does not have (the pairing-qr route before SRV-013).
	var no_route: Dictionary = {"message": "Route GET:/x not found", "error": "Not Found", "statusCode": 404}
	assert_eq(Format.classify(OK_RESULT, 404, no_route), Format.QR_UNAVAILABLE)
	assert_eq(Format.classify(OK_RESULT, 501, null), Format.QR_UNAVAILABLE)
	assert_eq(Format.classify(OK_RESULT, 500, error("INTERNAL")), Format.QR_FAILED)
	assert_eq(Format.classify(OK_RESULT, 410, error("QR_EXPIRED")), Format.QR_FAILED)
	assert_eq(Format.classify(HTTPRequest.RESULT_CANT_CONNECT, 0, null), Format.QR_NETWORK)
	assert_eq(Format.classify(HTTPRequest.RESULT_TIMEOUT, 0, null), Format.QR_NETWORK)


func test_addresses_start_with_the_qr_host_and_add_other_candidates() -> void:
	var options: Array[Dictionary] = Format.address_options("192.168.1.20", {"candidates": [
		{"address": "10.0.0.7", "interface": "Ethernet", "recommended": false, "virtual": false},
		{"address": "192.168.1.20", "interface": "Wi-Fi", "recommended": true, "virtual": false},
		{"address": "172.17.0.1", "interface": "docker0", "recommended": false, "virtual": true},
		{"address": "bad address", "interface": "x"},
		{"address": 5},
		"junk",
	]})
	assert_eq(options.size(), 3)
	assert_eq(options[0], {
		"address": "192.168.1.20", "interface": "Wi-Fi", "recommended": true, "virtual": false, "in_qr": true,
	})
	var second: Dictionary = options[1]
	var third: Dictionary = options[2]
	assert_eq(str(second.get("address")), "10.0.0.7")
	var second_in_qr: bool = second.get("in_qr") == true
	assert_false(second_in_qr)
	var third_virtual: bool = third.get("virtual") == true
	assert_true(third_virtual)
	assert_eq(Format.address_label(options[0], 7420), "192.168.1.20:7420 — Wi-Fi, рекомендуется, в QR")
	assert_eq(Format.address_label(options[2], 7420), "172.17.0.1:7420 — docker0, виртуальный адрес")


func test_without_a_candidate_list_only_the_qr_host_remains() -> void:
	for network: Variant in [null, {}, {"candidates": "x"}, []]:
		var options: Array[Dictionary] = Format.address_options("pc.local", network)
		assert_eq(options.size(), 1)
		var first: Dictionary = options[0]
		assert_eq(str(first.get("address")), "pc.local")
		assert_eq(Format.address_label(options[0], 7420), "pc.local:7420 — в QR")


func test_loopback_is_flagged_as_local_only() -> void:
	assert_true(Format.is_local_only("127.0.0.1"))
	assert_true(Format.is_local_only("LOCALHOST"))
	assert_false(Format.is_local_only("192.168.1.20"))


func test_expiry_counts_down_in_whole_seconds() -> void:
	assert_eq(Format.expiry_text(300_000, 0), "Код действует ещё 5:00")
	assert_eq(Format.expiry_text(300_000, 54_001), "Код действует ещё 4:06")
	assert_eq(Format.expiry_text(300_000, 299_999), "Код действует ещё 0:01")
	assert_eq(Format.expiry_text(300_000, 300_000), "Срок действия кода истёк")


func test_qr_side_is_a_whole_multiple_of_the_texture() -> void:
	assert_eq(Format.qr_display_side(37, 520), 518)
	assert_eq(Format.qr_display_side(29, 520), 493)
	assert_eq(Format.qr_display_side(600, 520), 600, "never below one screen pixel per module")
	assert_eq(Format.qr_display_side(0, 520), 0)


func test_start_needs_a_confirmed_online_phone_on_this_sessions_live_connection() -> void:
	assert_true(Format.can_start(State.ONLINE, "s1", "s1", "online"))
	assert_false(Format.can_start(State.ONLINE, "s1", "s1", "offline"))
	assert_false(Format.can_start(State.ONLINE, "s1", "s1", "unpaired"))
	assert_false(Format.can_start(State.ONLINE, "s1", "s1", "unknown"))
	assert_false(Format.can_start(State.RETRYING, "s1", "s1", "online"))
	assert_false(Format.can_start(State.HANDSHAKING, "s1", "s1", "online"))
	assert_false(Format.can_start(State.ONLINE, "s2", "s1", "online"))
	assert_false(Format.can_start(State.ONLINE, "", "", "online"))


func test_status_texts() -> void:
	assert_eq(Format.phone_text("online"), "Телефон в сети")
	assert_eq(Format.phone_text("unknown"), Format.PHONE_UNKNOWN_TEXT)
	assert_eq(Format.connection_text(State.ONLINE), "Игра подключена к серверу")
	assert_true(Format.is_paired("offline"))
	assert_false(Format.is_paired("unpaired"))
