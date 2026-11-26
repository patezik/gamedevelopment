extends Control
## Manual preview of NewGame and Pairing without a server (not part of GUT): a recording Backend
## answers with fixtures, so the layout and the QR can be inspected or captured.
##
##   godot --path apps/desktop res://tests/manual/pairing_preview.tscn -- --screen=pairing
##   ... -- --screen=new_game --capture=C:/tmp/new_game.png   (saves the frame and quits)
##
## The Pairing QR is the server matrix of `hs1:pair:192.168.1.20:7420:K7M2QX`
## (tests/fixtures/pairing_qr.json): the phone app reads it but cannot reach that address.

const NewGameScene = preload("res://src/scenes/new_game/new_game.tscn")
const NewGame = preload("res://src/scenes/new_game/new_game.gd")
const PairingScene = preload("res://src/scenes/pairing/pairing.tscn")
const Pairing = preload("res://src/scenes/pairing/pairing.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const FakeSessionBackend = preload("res://tests/unit/support/fake_session_backend.gd")
const FakeRouter = preload("res://tests/unit/support/fake_router.gd")

const SESSION_ID: String = "49a4ae5c-4174-416f-94c5-b8a7380636e5"
const PREVIEW_TOKEN: String = "preview-token-preview-token-preview-token-x"

var _backend: FakeSessionBackend
var _store: GameStoreScript


func _ready() -> void:
	var args: Dictionary = {}
	for argument: String in OS.get_cmdline_user_args():
		var parts: PackedStringArray = argument.trim_prefix("--").split("=", true, 1)
		args[parts[0]] = parts[1] if parts.size() > 1 else ""
	_backend = FakeSessionBackend.new()
	add_child(_backend)
	_store = GameStoreScript.new()
	add_child(_store)
	_store.bind_backend(_backend)
	var router: FakeRouter = FakeRouter.new()
	add_child(router)
	if str(args.get("screen", "pairing")) == "new_game":
		_show_new_game(router)
	else:
		_show_pairing(router)
	var capture: String = str(args.get("capture", ""))
	if not capture.is_empty():
		for _frame: int in range(10):
			await get_tree().process_frame
		var error: Error = get_viewport().get_texture().get_image().save_png(capture)
		print("capture %s: %s" % [capture, error_string(error)])
		get_tree().quit()


func _show_new_game(router: FakeRouter) -> void:
	var screen: NewGame = NewGameScene.instantiate() as NewGame
	screen.user_args = PackedStringArray()
	screen.bind_sources(_backend, router)
	add_child(screen)
	_backend.answer(_backend.last_call().id, 200, [
		{"id": "sanatorium_winter", "title": "Санаторий «Сосновый бор»", "durationMinutes": 4320.0},
	])


func _show_pairing(router: FakeRouter) -> void:
	var now: int = int(Time.get_unix_time_from_system() * 1000.0)
	PairingSession.set_current(PairingSession.from_response("http://127.0.0.1:7420", {
		"sessionId": SESSION_ID,
		"desktopToken": PREVIEW_TOKEN,
		"pairing": {
			"code": "K7M2QX", "expiresAt": float(now + 300_000),
			"qrPayload": "hs1:pair:192.168.1.20:7420:K7M2QX",
		},
	}))
	_backend.connect_session("ws://127.0.0.1:7420/ws", PREVIEW_TOKEN)
	var screen: Pairing = PairingScene.instantiate() as Pairing
	screen.bind_sources(_backend, _store, router)
	add_child(screen)
	var matrix: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://tests/fixtures/pairing_qr.json"))
	_backend.answer(_backend.calls_to("/pairing-qr")[0].id, 200, matrix)
	_backend.answer(_backend.calls_to("/api/v1/network")[0].id, 200, {"candidates": [
		{"address": "192.168.1.20", "interface": "Wi-Fi", "recommended": true, "virtual": false},
		{"address": "172.17.0.1", "interface": "vEthernet (WSL)", "recommended": false, "virtual": true},
	]})
	_backend.welcome(SESSION_ID)
	_backend.peer_status("online", "unpaired")
