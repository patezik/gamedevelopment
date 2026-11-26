extends GutTest
## PairingSession: the 201 answer of POST /sessions is accepted only in its contract shape, and the
## desktop token stays out of every printable form of the session.

const ORIGIN: String = "http://127.0.0.1:7420"
const SESSION_ID: String = "49a4ae5c-4174-416f-94c5-b8a7380636e5"
const TOKEN: String = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"


static func answer(overrides: Dictionary = {}) -> Dictionary:
	var body: Dictionary = {
		"sessionId": SESSION_ID,
		"desktopToken": TOKEN,
		"pairing": {
			"code": "K7M2QX", "expiresAt": 1795683501742.0,
			"qrPayload": "hs1:pair:192.168.1.20:7420:K7M2QX",
		},
	}
	body.merge(overrides, true)
	return body


func after_each() -> void:
	PairingSession.clear()


func test_a_valid_answer_becomes_a_session() -> void:
	var session: PairingSession = PairingSession.from_response(ORIGIN, answer())
	assert_not_null(session)
	assert_eq(session.origin, ORIGIN)
	assert_eq(session.session_id, SESSION_ID)
	assert_eq(session.desktop_token(), TOKEN)
	assert_eq(session.code, "K7M2QX")
	assert_eq(session.expires_at, 1795683501742)
	assert_eq(session.qr_host, "192.168.1.20")
	assert_eq(session.qr_port, 7420)


func test_routes_are_built_from_the_origin_and_the_session() -> void:
	var session: PairingSession = PairingSession.from_response(ORIGIN, answer())
	assert_eq(session.ws_url(), "ws://127.0.0.1:7420/ws")
	assert_eq(session.endpoint("pairing-qr"), ORIGIN + "/api/v1/sessions/" + SESSION_ID + "/pairing-qr")
	var secure: PairingSession = PairingSession.from_response("https://host:7420", answer())
	assert_eq(secure.ws_url(), "wss://host:7420/ws")


func test_the_token_is_not_part_of_the_printed_session() -> void:
	var session: PairingSession = PairingSession.from_response(ORIGIN, answer())
	assert_eq(str(session), "PairingSession(%s)" % SESSION_ID)
	assert_false(str(session).contains(TOKEN))
	assert_false(str([session]).contains(TOKEN), "nor inside a printed collection")


func test_answers_outside_the_contract_are_refused() -> void:
	var broken: Array[Dictionary] = [
		{"sessionId": "not-a-uuid"},
		{"sessionId": 5},
		{"desktopToken": "short"},
		{"desktopToken": TOKEN + "!"},
		{"pairing": null},
		{"pairing": {"code": "K7M2QX", "expiresAt": 1.0, "qrPayload": "hs1:pair:h:7420:AAAAAA"}},
		{"pairing": {"code": "k7m2qx", "expiresAt": 1.0, "qrPayload": "hs1:pair:h:7420:k7m2qx"}},
		{"pairing": {"code": "K7M2QX", "expiresAt": -5.0, "qrPayload": "hs1:pair:h:7420:K7M2QX"}},
		{"pairing": {"code": "K7M2QX", "expiresAt": 1.5, "qrPayload": "hs1:pair:h:7420:K7M2QX"}},
		{"pairing": {"code": "K7M2QX", "expiresAt": 1.0, "qrPayload": "hs1:pair:h:70000:K7M2QX"}},
		{"pairing": {"code": "K7M2QX", "expiresAt": 1.0, "qrPayload": "hs1:ev:h:7420:K7M2QX"}},
		{"pairing": {"code": "K7M2QX", "expiresAt": 1.0, "qrPayload": "hs1:pair:fe80::1:7420:K7M2QX"}},
	]
	for overrides: Dictionary in broken:
		assert_null(PairingSession.from_response(ORIGIN, answer(overrides)), str(overrides))
	assert_null(PairingSession.from_response(ORIGIN, null))
	assert_null(PairingSession.from_response(ORIGIN, [answer()]))


func test_current_session_is_set_and_cleared() -> void:
	assert_null(PairingSession.current())
	var session: PairingSession = PairingSession.from_response(ORIGIN, answer())
	PairingSession.set_current(session)
	assert_same(PairingSession.current(), session)
	PairingSession.clear()
	assert_null(PairingSession.current())


func test_a_new_pairing_replaces_the_code_and_the_qr_address() -> void:
	var session: PairingSession = PairingSession.from_response(ORIGIN, answer())
	var pairing: Dictionary = PairingSession.parse_pairing({
		"code": "ZZ9Y8X", "expiresAt": 1795683800000.0, "qrPayload": "hs1:pair:pc.local:7421:ZZ9Y8X",
	})
	session.apply_pairing(pairing)
	assert_eq(session.code, "ZZ9Y8X")
	assert_eq(session.expires_at, 1795683800000)
	assert_eq(session.qr_host, "pc.local")
	assert_eq(session.qr_port, 7421)
	assert_eq(session.desktop_token(), TOKEN, "the token belongs to the session, not to the code")


func test_a_trailing_newline_does_not_pass_a_pattern() -> void:
	assert_null(PairingSession.from_response(ORIGIN, answer({"desktopToken": TOKEN + "\n"})))
	assert_null(PairingSession.from_response(ORIGIN, answer({"sessionId": SESSION_ID + "\n"})))
	assert_eq(PairingSession.parse_pairing({
		"code": "K7M2QX", "expiresAt": 1.0, "qrPayload": "hs1:pair:h:7420:K7M2QX\n",
	}), {})
