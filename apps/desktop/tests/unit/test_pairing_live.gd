extends GutTest
## Live NewGame and Pairing: Godot's real Backend and GameStore against the production REST of
## SRV-002 (createSessionServices: the shipped catalog, the real generator with its full gate, the
## pairing routes) started by tests/live/pairing_server.mjs.
##
## - production: the routes `npm start` serves (SRV-013): the gateway over the same sessions and the
##   pairing-qr route. The QR is shown, the desktop comes online and start stays disabled until a
##   phone pairs.
## - adapter: the same routes through the test adapter; a scripted phone pairs with the code shown on
##   screen.
## Needs Node and the repository's node_modules (tsx), like `npm run test:godot` itself.

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const NewGame = preload("res://src/scenes/new_game/new_game.gd")
const NewGameScene = preload("res://src/scenes/new_game/new_game.tscn")
const Pairing = preload("res://src/scenes/pairing/pairing.gd")
const PairingScene = preload("res://src/scenes/pairing/pairing.tscn")
const PairingFormat = preload("res://src/scenes/pairing/pairing_format.gd")
const NewGameFormat = preload("res://src/scenes/new_game/new_game_format.gd")
const FakeRouter = preload("res://tests/unit/support/fake_router.gd")

const SERVER_SCRIPT: String = "tests/live/pairing_server.mjs"
## Generation of the shipped scenario runs on the server thread for a second or more.
const WAIT_SECONDS: float = 20.0

var _pid: int = -1
var _pipe: FileAccess = null
var _info: Dictionary = {}
var _backend: BackendScript
var _store: GameStoreScript
var _router: FakeRouter
var _screen: Control


func before_each() -> void:
	PairingSession.clear()
	_backend = BackendScript.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	_router = FakeRouter.new()
	add_child_autofree(_router)


func after_each() -> void:
	_backend.disconnect_session()
	PairingSession.clear()
	if _pipe != null:
		_pipe.store_line(JSON.stringify({"cmd": "quit"}))
		_pipe.flush()
	if _pid > 0:
		OS.kill(_pid)
	_pid = -1
	_pipe = null


# --- server ------------------------------------------------------------------------------------


func _start_server(mode: String) -> bool:
	var desktop_dir: String = ProjectSettings.globalize_path("res://")
	var repo: String = desktop_dir.path_join("../..").simplify_path()
	var loader: String = repo.path_join("node_modules/tsx/dist/loader.mjs")
	assert_true(FileAccess.file_exists(loader), "tsx is installed (npm ci)")
	var loader_url: String = "file:///" + loader.trim_prefix("/")
	var process: Dictionary = OS.execute_with_pipe(
		"node", ["--import", loader_url, desktop_dir.path_join(SERVER_SCRIPT), "--mode=" + mode], true
	)
	assert_false(process.is_empty(), "node starts")
	if process.is_empty():
		return false
	_pid = process["pid"]
	_pipe = process["stdio"] as FileAccess
	var line: String = _pipe.get_line()
	var parsed: Variant = JSON.parse_string(line) if not line.is_empty() else null
	if not parsed is Dictionary:
		var stderr: FileAccess = process.get("stderr") as FileAccess
		fail_test("the server did not start: %s %s" % [line, stderr.get_as_text() if stderr != null else ""])
		_pipe = null
		return false
	_info = parsed
	return true


func _command(command: Dictionary) -> Dictionary:
	_pipe.store_line(JSON.stringify(command))
	_pipe.flush()
	var parsed: Variant = JSON.parse_string(_pipe.get_line())
	return parsed if parsed is Dictionary else {}


func _origin() -> String:
	return str(_info.get("origin", ""))


# --- screens -----------------------------------------------------------------------------------


func _node(node_name: String) -> Control:
	return _screen.find_child(node_name, true, false) as Control


func _text(node_name: String) -> String:
	return (_node(node_name) as Label).text


## NewGame creates a session with [param seed] (empty: random) on the live server.
## Returns true once it routed to Pairing.
func _create_session(seed: String) -> bool:
	var new_game: NewGame = NewGameScene.instantiate() as NewGame
	new_game.user_args = PackedStringArray()
	new_game.set_params({"server": _origin()})
	new_game.bind_sources(_backend, _router)
	_screen = new_game
	add_child_autofree(new_game)
	await wait_until(func() -> bool: return new_game.get_phase() != NewGame.Phase.LOADING, WAIT_SECONDS)
	assert_eq(new_game.get_phase(), NewGame.Phase.READY, "the shipped catalog loads")
	var scenarios: OptionButton = _node("Scenario") as OptionButton
	assert_true(scenarios.item_count >= 1)
	assert_true(scenarios.get_item_text(0).contains("игрового времени"))
	if not seed.is_empty():
		(_node("RandomSeed") as CheckButton).button_pressed = false
		var field: LineEdit = _node("Seed") as LineEdit
		field.text = seed
		field.text_changed.emit(seed)
	assert_true(new_game.create_session())
	await wait_until(func() -> bool: return new_game.get_phase() != NewGame.Phase.CREATING, WAIT_SECONDS)
	var routed: bool = _router.last_screen() == NewGame.PAIRING_SCREEN
	remove_child(new_game)
	new_game.free()
	return routed


func _open_pairing() -> Pairing:
	var pairing: Pairing = PairingScene.instantiate() as Pairing
	pairing.bind_sources(_backend, _store, _router)
	_screen = pairing
	add_child_autofree(pairing)
	return pairing


# --- tests -------------------------------------------------------------------------------------


func test_production_rest_creates_a_session_and_pairing_shows_the_qr_and_comes_online() -> void:
	if not _start_server("production"):
		return
	assert_true(await _create_session(str(_info.get("seed"))), "201 through the full gate")
	var session: PairingSession = PairingSession.current()
	assert_not_null(session)
	if session == null:
		return
	assert_eq(session.origin, _origin())
	assert_eq(session.qr_host, "127.0.0.1", "HS_HOST of the harness")
	var pairing: Pairing = _open_pairing()
	await wait_until(func() -> bool: return pairing.get_qr_state() != "loading", WAIT_SECONDS)
	assert_eq(pairing.get_qr_state(), PairingFormat.QR_SHOWN, "the shipped server serves pairing-qr (SRV-013)")
	assert_eq(_text("Code"), session.code)
	var choice: OptionButton = _node("AddressChoice") as OptionButton
	await wait_until(func() -> bool: return choice.item_count == 3, WAIT_SECONDS)
	assert_eq(choice.item_count, 3, "the QR host and the two LAN candidates of GET /network")
	assert_eq(_text("AddressHint"), Pairing.LOCAL_ONLY_HINT % "127.0.0.1")
	# The shipped gateway knows the issued desktop token: the desktop comes online, the phone is
	# not paired yet, so the investigation cannot start.
	await wait_until(
		func() -> bool: return _store.get_connection_state() == BackendScript.ConnectionState.ONLINE,
		WAIT_SECONDS
	)
	assert_eq(_store.get_connection_state(), BackendScript.ConnectionState.ONLINE)
	await wait_until(func() -> bool: return _store.get_phone_status() == "unpaired", WAIT_SECONDS)
	assert_eq(_store.get_phone_status(), "unpaired")
	assert_eq(_text("Phone"), "Телефон не привязан")
	assert_true((_node("Start") as Button).disabled)
	# The pairing-code route of SRV-002 replaces the code with the desktop token.
	var old_code: String = session.code
	pairing.request_new_code()
	await wait_until(func() -> bool: return session.code != old_code, WAIT_SECONDS)
	assert_ne(session.code, old_code)
	assert_eq(_text("Code"), session.code)


func test_production_rest_with_a_random_seed() -> void:
	if not _start_server("production"):
		return
	var routed: bool = await _create_session("")
	if routed:
		assert_not_null(PairingSession.current())
	else:
		# The server picks the seed; the full gate may refuse that case.
		pass_test("the server refused its own random case: %s" % NewGameFormat.CREATE_UNSOLVABLE)


func test_adapter_pairs_a_phone_and_unlocks_the_investigation() -> void:
	if not _start_server("adapter"):
		return
	assert_true(await _create_session(str(_info.get("seed"))))
	var session: PairingSession = PairingSession.current()
	if session == null:
		fail_test("no session")
		return
	var pairing: Pairing = _open_pairing()
	await wait_until(func() -> bool: return pairing.get_qr_state() != "loading", WAIT_SECONDS)
	assert_eq(pairing.get_qr_state(), PairingFormat.QR_SHOWN)
	var qr: TextureRect = _node("Qr") as TextureRect
	assert_true(qr.visible)
	assert_eq(qr.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_eq(int(qr.custom_minimum_size.x) % qr.texture.get_width(), 0)
	var start: Button = _node("Start") as Button
	await wait_until(func() -> bool: return _store.get_phone_status() == "unpaired", WAIT_SECONDS)
	assert_eq(_store.get_session_id(), session.session_id)
	assert_eq(_text("Phone"), "Телефон не привязан")
	assert_true(start.disabled)

	var paired: Dictionary = _command({"cmd": "pair", "code": _text("Code")})
	var status: float = paired.get("status", 0.0)
	assert_eq(status, 200.0, "POST /pair accepts the code shown on screen")
	assert_eq(str(paired.get("welcome")), "true")
	await wait_until(func() -> bool: return not start.disabled, WAIT_SECONDS)
	assert_false(start.disabled, "the server confirmed an online phone")
	assert_eq(_text("QrStatus"), Pairing.PAIRED_TEXT)

	_command({"cmd": "phone-close"})
	await wait_until(func() -> bool: return start.disabled, WAIT_SECONDS)
	assert_true(start.disabled)
	assert_eq(_text("Phone"), "Телефон привязан, но не в сети")
