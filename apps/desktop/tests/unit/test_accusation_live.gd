extends GutTest
## Live regressions of the accusation (review of PR #123): Godot's real Backend and GameStore talk
## over WebSocket to the real SessionGateway with real GameEngines on tiny-manor
## (tests/live/accusation_server.mjs). Faults are injected on the server's sockets: a lost
## `action.result` with a dropped connection, a lost `view.update` on a live connection, and a
## switch to another session with the same character ids. The server reports every `accuse` its
## engines received, so the tests check what reached the game, not only what the client sent.
## Needs Node and the repository's node_modules (tsx), like `npm run test:godot` itself.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const AudioDirectorScript = preload("res://src/autoload/audio_director.gd")
const AccusationScene = preload("res://src/scenes/accusation/accusation.tscn")
const Accusation = preload("res://src/scenes/accusation/accusation.gd")
const AccusationLedger = preload("res://src/scenes/accusation/accusation_ledger.gd")
const Ending = preload("res://src/scenes/ending/ending.gd")

const SERVER_SCRIPT: String = "tests/live/accusation_server.mjs"
const CULPRIT: String = "ch_bursar"
const INNOCENT: String = "ch_cook"
const WAIT_SECONDS: float = 10.0

var _pid: int = -1
var _pipe: FileAccess = null
var _info: Dictionary = {}
var _backend: BackendScript
var _store: GameStoreScript
var _audio: AudioDirectorScript
var _router: SceneRouterScript
var _host: Control
var _old_fade: float


func before_each() -> void:
	_audio = get_node(^"/root/AudioDirector") as AudioDirectorScript
	_audio.bind_store(null)
	_router = get_node(^"/root/SceneRouter") as SceneRouterScript
	_host = Control.new()
	add_child_autofree(_host)
	_old_fade = _router.fade_seconds
	_router.host = _host
	_router.fade_seconds = 0.0
	# The router is an autoload: start from a known screen under this test's host.
	_router.goto(&"bootstrap")
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)
	var ledger: Node = get_tree().root.get_node_or_null(NodePath(AccusationLedger.NODE_NAME))
	if ledger != null:
		get_tree().root.remove_child(ledger)
		ledger.free()
	get_tree().root.remove_meta(AccusationLedger.META_KEY)
	_backend = BackendScript.new()
	add_child_autofree(_backend)
	_store = get_node(^"/root/GameStore") as GameStoreScript
	_store.bind_backend(_backend)
	_start_server()


func after_each() -> void:
	_backend.disconnect_session()
	if _pipe != null:
		_pipe.store_line(JSON.stringify({"cmd": "quit"}))
		_pipe.flush()
	if _pid > 0:
		OS.kill(_pid)
	_pid = -1
	_pipe = null
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)
	_router.host = null
	_router.fade_seconds = _old_fade
	await get_tree().process_frame
	_store.bind_backend(get_node(^"/root/Backend") as BackendScript)
	_audio.bind_store(_store)


# --- server ------------------------------------------------------------------------------------


func _start_server() -> void:
	var desktop_dir: String = ProjectSettings.globalize_path("res://")
	var repo: String = desktop_dir.path_join("../..").simplify_path()
	var loader: String = repo.path_join("node_modules/tsx/dist/loader.mjs")
	assert_true(FileAccess.file_exists(loader), "tsx is installed (npm ci)")
	var loader_url: String = "file:///" + loader.trim_prefix("/")
	var process: Dictionary = OS.execute_with_pipe(
		"node", ["--import", loader_url, desktop_dir.path_join(SERVER_SCRIPT)], true
	)
	assert_false(process.is_empty(), "node starts")
	if process.is_empty():
		return
	_pid = process["pid"]
	_pipe = process["stdio"] as FileAccess
	# Blocking pipe: waits for the server's first line.
	var line: String = _pipe.get_line()
	var parsed: Variant = JSON.parse_string(line) if not line.is_empty() else null
	if not parsed is Dictionary:
		var stderr: FileAccess = process.get("stderr") as FileAccess
		var details: String = stderr.get_as_text() if stderr != null else ""
		fail_test("the server did not start: %s %s" % [line, details])
		_pipe = null
		return
	if parsed is Dictionary:
		_info = parsed


func _command(command: Dictionary) -> Dictionary:
	_pipe.store_line(JSON.stringify(command))
	_pipe.flush()
	var parsed: Variant = JSON.parse_string(_pipe.get_line())
	return parsed if parsed is Dictionary else {}


## Accusations each session's engine received: [{confirm, caseFile, ok}, ...].
func _received(session: String) -> Array:
	var report: Dictionary = _command({"cmd": "report"})
	var entry: Dictionary = report.get(session, {})
	return entry.get("accusations", [])


func _connect(session: String) -> bool:
	var sessions: Dictionary = _info.get("sessions", {})
	var entry: Dictionary = sessions.get(session, {})
	_backend.connect_session(str(_info.get("url", "")), str(entry.get("token", "")))
	await wait_until(func() -> bool: return _store.is_online() and _store.has_view(), WAIT_SECONDS)
	return _store.is_online() and _store.has_view() and _store.get_session_id() == str(entry.get("id"))


## Marks the cook as a suspect so the view names a second character (as on the case board).
func _know_the_cook() -> void:
	var version: int = _store.get_state_version()
	var action: Dictionary = {"type": "markSuspicion", "characterId": INNOCENT, "level": 1}
	assert_eq(_store.request_action(action), OK)
	await wait_until(func() -> bool: return _store.get_state_version() > version, WAIT_SECONDS)


func _screen() -> Accusation:
	var screen: Accusation = AccusationScene.instantiate() as Accusation
	screen.set_params({"back": "case_board"})
	add_child_autofree(screen)
	return screen


## Choice → first confirmation → `confirm: false` → the server's answer → final confirmation open.
func _reach_final(screen: Accusation, accused: Array[String]) -> void:
	screen.set_accused(accused)
	screen.set_claim("means", CULPRIT)
	screen.set_claim("opportunity", CULPRIT)
	screen.set_evidence(screen.get_clue_ids())
	assert_eq(screen.request_accusation(), OK)
	screen.get_first_dialog().confirmed.emit()
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.FINAL, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.FINAL)


func _confirm_true_count(entries: Array) -> int:
	var count: int = 0
	for entry: Variant in entries:
		if entry is Dictionary and (entry as Dictionary).get("confirm") == true:
			count += 1
	return count


# --- regressions -------------------------------------------------------------------------------


func test_live_lost_result_of_an_executed_accusation_is_recovered_by_a_retry() -> void:
	var live: bool = _pipe != null and await _connect("a")
	assert_true(live, "a live session")
	if not live:
		return
	await _know_the_cook()
	var screen: Accusation = _screen()
	await _reach_final(screen, [INNOCENT] as Array[String])
	# The server executes it (a wrong first accusation: forgiven), the result never arrives and the
	# socket drops; the client resumes and gets the snapshot without `ending`.
	_command({"cmd": "drop", "type": "action.result", "close": true})
	screen.get_final_dialog().confirmed.emit()
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.UNKNOWN, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.UNKNOWN)
	assert_eq(screen.request_accusation(), ERR_UNAVAILABLE, "no second accusation while unknown")
	# After the reconnect the same accusation goes out under the same operationId; the server
	# answers with the stored outcome and does not execute it again.
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.EDITING, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING, "the outcome became known")
	assert_true(_store.is_online(), "reconnected")
	assert_false(_store.get_view().has("ending"), "the game went on")
	assert_string_contains(screen.get_status_text(), "продолжается")
	assert_true(screen.can_go_back())
	var received: Array = _received("a")
	assert_eq(_confirm_true_count(received), 1, "the engine got exactly one confirm:true: %s" % [received])


func test_live_final_confirmation_of_session_a_never_reaches_session_b() -> void:
	var live: bool = _pipe != null and await _connect("a")
	assert_true(live, "a live session")
	if not live:
		return
	var screen: Accusation = _screen()
	await _reach_final(screen, [CULPRIT] as Array[String])
	assert_true(screen.get_final_dialog().visible)
	# The same client switches to session B (same scenario, same character ids).
	assert_true(await _connect("b"), "session B is live")
	screen.get_final_dialog().confirmed.emit()
	await get_tree().create_timer(0.5).timeout
	assert_false(screen.get_final_dialog().visible)
	assert_eq(_received("b"), [], "session B received no accusation at all")
	assert_eq(_confirm_true_count(_received("a")), 0, "session A only got its confirm:false")


func test_live_lost_view_on_a_live_connection_does_not_trap_the_player() -> void:
	var live: bool = _pipe != null and await _connect("a")
	assert_true(live, "a live session")
	if not live:
		return
	await _know_the_cook()
	var screen: Accusation = _screen()
	await _reach_final(screen, [INNOCENT] as Array[String])
	_command({"cmd": "drop", "type": "view.update", "close": false})
	screen.get_final_dialog().confirmed.emit()
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.AWAITING_VIEW, WAIT_SECONDS)
	await get_tree().create_timer(0.5).timeout
	assert_eq(screen.get_stage(), Accusation.Stage.AWAITING_VIEW, "the view was lost")
	assert_true(_store.is_online(), "the connection is alive")
	screen.get_ledger().call(&"advance", AccusationLedger.VIEW_TIMEOUT_SECONDS)
	assert_true(screen.can_go_back(), "the way back unlocks")
	assert_eq(screen.request_accusation(), ERR_BUSY, "a new accusation waits for the state")
	# Any later state of this connection follows the accepted accusation and settles it.
	var version: int = _store.get_state_version()
	_store.request_action({"type": "wait", "minutes": 15})
	await wait_until(func() -> bool: return _store.get_state_version() > version, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_status_text(), "продолжается")
	assert_eq(_confirm_true_count(_received("a")), 1)


func test_live_several_accused_unchanged_in_both_phases_then_an_ending() -> void:
	var live: bool = _pipe != null and await _connect("a")
	assert_true(live, "a live session")
	if not live:
		return
	await _know_the_cook()
	var screen: Accusation = _screen()
	await _reach_final(screen, [CULPRIT, INNOCENT] as Array[String])
	screen.get_final_dialog().confirmed.emit()
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.EDITING, WAIT_SECONDS)
	var received: Array = _received("a")
	assert_eq(received.size(), 2, "both phases reached the engine: %s" % [received])
	if received.size() == 2:
		var probe: Dictionary = received[0]
		var final: Dictionary = received[1]
		var accused: Array = (probe["caseFile"] as Dictionary)["accusedIds"]
		assert_eq(accused.size(), 2)
		assert_eq(str(probe["caseFile"]), str(final["caseFile"]), "the same case file twice")
		assert_false(probe["confirm"] as bool)
		assert_true(final["confirm"] as bool)
	assert_string_contains(screen.get_status_text(), "продолжается", "two accused are not the culprit")
	# The real culprit, means and opportunity proven, no motive: the game ends `partial`.
	await _reach_final(screen, [CULPRIT] as Array[String])
	screen.get_final_dialog().confirmed.emit()
	await wait_until(func() -> bool: return _host.get_child_count() > 0 and _host.get_child(0) is Ending, WAIT_SECONDS)
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)
	assert_eq(_router.get_current_screen(), &"ending")
	assert_eq(screen.get_stage(), Accusation.Stage.ENDED)
	var ending: Ending = _host.get_child(0) as Ending if _host.get_child_count() > 0 else null
	assert_not_null(ending, "the ending screen is mounted")
	if ending == null:
		return
	assert_eq(ending.get_ending_id(), "partial")
	assert_true(ending.has_recap(), "the TruthRecap comes with the ending")

func test_live_unknown_survives_switching_games_and_is_settled_on_return() -> void:
	var live: bool = _pipe != null and await _connect("a")
	assert_true(live, "a live session")
	if not live:
		return
	await _know_the_cook()
	var screen: Accusation = _screen()
	await _reach_final(screen, [INNOCENT] as Array[String])
	_command({"cmd": "drop", "type": "action.result", "close": true})
	screen.get_final_dialog().confirmed.emit()
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.UNKNOWN, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.UNKNOWN)
	# Leave before the automatic reconnect: the unknown outcome must outlive the other game.
	_backend.disconnect_session()
	assert_eq(_confirm_true_count(_received("a")), 1, "the first accusation was executed")
	assert_true(await _connect("b"), "switch to another game")
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_true(await _connect("a"), "return to the game with an unknown result")
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.EDITING, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING)
	assert_string_contains(screen.get_status_text(), "продолжается")
	assert_eq(_confirm_true_count(_received("a")), 1, "the retry did not run it a second time")
	assert_eq(_received("b"), [])


func test_live_probe_times_out_and_ignores_its_late_result() -> void:
	var live: bool = _pipe != null and await _connect("a")
	assert_true(live, "a live session")
	if not live:
		return
	var screen: Accusation = _screen()
	screen.set_accused([CULPRIT])
	assert_eq(screen.request_accusation(), OK)
	_command({"cmd": "hold", "type": "action.result"})
	screen.get_first_dialog().confirmed.emit()
	assert_eq(screen.get_stage(), Accusation.Stage.PROBING)
	await wait_until(func() -> bool: return screen.get_stage() == Accusation.Stage.EDITING, WAIT_SECONDS)
	assert_eq(screen.get_stage(), Accusation.Stage.EDITING, "the probe timed out")
	assert_true(_store.is_online())
	assert_true(screen.can_go_back())
	assert_eq(screen.get_accused(), [CULPRIT] as Array[String], "the player can try again")

	watch_signals(_store)
	_command({"cmd": "release"})
	await wait_until(func() -> bool: return get_signal_emit_count(_store, "action_resolved") == 1, WAIT_SECONDS)
	assert_signal_emitted(_store, "action_resolved")
	assert_false(screen.get_final_dialog().visible)
	screen.get_final_dialog().confirmed.emit()
	assert_eq(_confirm_true_count(_received("a")), 0)

	await _reach_final(screen, [CULPRIT] as Array[String])
	assert_eq(_confirm_true_count(_received("a")), 0)
