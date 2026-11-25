extends GutTest
## Scene transitions of the finale (GDT-009): case board → accusation → back, the accusation that
## ends the game → ending, EndingWatcher for endings reached elsewhere, ending → case board.
## Uses the SceneRouter and GameStore autoloads (screens bind to them), with a test host and a
## fake backend.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const AudioDirectorScript = preload("res://src/autoload/audio_director.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")
const Fixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const EndingFixtures = preload("res://src/scenes/ending/ending_fixtures.gd")
const EndingWatcher = preload("res://src/scenes/ending/ending_watcher.gd")
const Accusation = preload("res://src/scenes/accusation/accusation.gd")
const Ending = preload("res://src/scenes/ending/ending.gd")
const AccusationLedger = preload("res://src/scenes/accusation/accusation_ledger.gd")

var _backend: FakeBackend
var _store: GameStoreScript
var _audio: AudioDirectorScript
var _router: SceneRouterScript
var _host: Control
var _old_fade: float
var _version: int = 0


func before_each() -> void:
	_audio = get_node(^"/root/AudioDirector") as AudioDirectorScript
	_audio.bind_store(null)
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = get_node(^"/root/GameStore") as GameStoreScript
	_store.bind_backend(_backend)
	_backend.set_session_id("session-a")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_router = get_node(^"/root/SceneRouter") as SceneRouterScript
	_host = Control.new()
	add_child_autofree(_host)
	_old_fade = _router.fade_seconds
	_router.host = _host
	_router.fade_seconds = 0.0
	_version = 0
	var ledger: Node = get_tree().root.get_node_or_null(NodePath(AccusationLedger.NODE_NAME))
	if ledger != null:
		get_tree().root.remove_child(ledger)
		ledger.free()
	get_tree().root.remove_meta(AccusationLedger.META_KEY)


func after_each() -> void:
	await _settle()
	_router.host = null
	_router.fade_seconds = _old_fade
	await get_tree().process_frame
	_store.bind_backend(get_node(^"/root/Backend") as BackendScript)
	_audio.bind_store(_store)


func _settle() -> void:
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)


func _publish(view: Dictionary) -> void:
	_version += 1
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": _version, "view": view})


func _result(ok: bool) -> void:
	_backend.deliver(ProtocolConstants.MSG_ACTION_RESULT, {
		"ok": ok, "requestId": "desktop-%d" % _backend.sent.size(), "minutesSpent": 0,
	})


func _screen() -> Node:
	return _host.get_child(_host.get_child_count() - 1) if _host.get_child_count() > 0 else null


func test_finale_screens_are_registered() -> void:
	assert_true(_router.has_screen(&"accusation"))
	assert_true(_router.has_screen(&"ending"))


func test_case_board_opens_the_accusation_and_back_returns_with_its_params() -> void:
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"case_board", {"back": "exploration"})
	await _settle()
	var board: Node = _screen()
	var accuse: Button = board.get_node(^"%Accuse") as Button
	assert_true(accuse.visible, "the board offers the accusation")
	accuse.pressed.emit()
	await _settle()
	assert_eq(_router.get_current_screen(), &"accusation")
	assert_eq(_router.get_current_params(), {"back": "case_board", "backParams": {"back": "exploration"}})
	var screen: Accusation = _screen() as Accusation
	(screen.find_child("Back", true, false) as Button).pressed.emit()
	await _settle()
	assert_eq(_router.get_current_screen(), &"case_board")
	assert_eq(_router.get_current_params(), {"back": "exploration"}, "the board keeps its own way back")
	assert_eq(_backend.sent.size(), 0, "navigating sends no action")


func test_accusation_that_ends_the_game_opens_the_ending() -> void:
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"accusation", {"back": "case_board"})
	await _settle()
	var screen: Accusation = _screen() as Accusation
	screen.set_accused(["ch_doctor"])
	screen.request_accusation()
	screen.get_first_dialog().confirmed.emit()
	_result(true)
	screen.get_final_dialog().confirmed.emit()
	assert_true((screen.find_child("Back", true, false) as Button).disabled, "no way back while the accusation is in flight")
	_result(true)
	_publish(EndingFixtures.view_for("wrong_accusation").duplicate(true))
	await _settle()
	assert_eq(_router.get_current_screen(), &"ending")
	var ending: Ending = _screen() as Ending
	assert_eq(ending.get_ending_id(), "wrong_accusation")
	assert_true(ending.has_recap())
	assert_eq(_backend.sent.size(), 2, "one probe and one accusation")


func test_watcher_opens_the_ending_reached_anywhere_once() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	assert_false(watcher.call(&"has_shown_ending") as bool)
	watch_signals(_router)
	_publish(EndingFixtures.view_for("death").duplicate(true))
	await _settle()
	assert_eq(_router.get_current_screen(), &"ending")
	assert_eq((_screen() as Ending).get_ending_id(), "death")
	_router.goto(&"case_board", {"back": "ending"})
	await _settle()
	var death: Dictionary = EndingFixtures.view_for("death").duplicate(true)
	_publish(death)
	_backend.deliver(ProtocolConstants.MSG_EVENT, {"event": {"type": ProtocolConstants.EVENT_GAME_OVER}})
	await _settle()
	assert_eq(_router.get_current_screen(), &"case_board", "the ending opens once per game")
	assert_signal_emit_count(_router, "transition_started", 2)


func test_watcher_reacts_to_game_over_and_a_new_session() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	assert_eq(EndingWatcher.open_ending(null), ERR_UNCONFIGURED)
	_publish(EndingFixtures.view_for("time_up").duplicate(true))
	await _settle()
	assert_eq(_router.get_current_screen(), &"ending")
	assert_eq(EndingWatcher.open_ending(_router), ERR_ALREADY_EXISTS)
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	assert_false(watcher.call(&"has_shown_ending") as bool, "a new session may end again")


func test_ending_opens_the_case_board_to_review_the_case() -> void:
	_publish(EndingFixtures.view_for("solved").duplicate(true))
	_router.goto(&"ending")
	await _settle()
	var ending: Ending = _screen() as Ending
	(ending.find_child("CaseBoard", true, false) as Button).pressed.emit()
	await _settle()
	assert_eq(_router.get_current_screen(), &"case_board")
	assert_eq(_router.get_current_params(), {"back": "ending"})
	var board: Node = _screen()
	assert_false((board.get_node(^"%Accuse") as Button).visible, "no accusation after the end")


# --- regression: the terminal route cannot be displaced (review P1-3) ---------------------------


func test_escape_during_the_fade_to_the_ending_cannot_displace_it() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"dialogue", {"characterId": "ch_doctor"})
	await _settle()
	assert_eq(_router.get_current_screen(), &"dialogue")
	_router.fade_seconds = 0.1
	_publish(EndingFixtures.view_for("death").duplicate(true))
	assert_true(_router.is_transitioning(), "the fade to the ending runs")
	assert_eq(_router.get_terminal_screen(), &"ending")
	# Escape in the dialogue during the fade: its way back to exploration.
	var escape: InputEventAction = InputEventAction.new()
	escape.action = &"ui_cancel"
	escape.pressed = true
	(_screen() as Control).call(&"_unhandled_input", escape)
	assert_eq(_router.goto(&"exploration"), ERR_LOCKED, "an ordinary route waits for the ending")
	await _settle()
	assert_eq(_router.get_current_screen(), &"ending")
	assert_true(watcher.call(&"has_shown_ending") as bool, "counted once actually mounted")
	_router.fade_seconds = 0.0
	assert_eq(_router.goto(&"case_board", {"back": "ending"}), OK, "after the ending, by choice")
	await _settle()
	assert_eq(_router.get_current_screen(), &"case_board")


func test_watcher_installed_late_honours_a_terminal_snapshot() -> void:
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	_publish(EndingFixtures.view_for("madness").duplicate(true))
	assert_eq(_router.get_current_screen(), &"exploration", "no watcher yet")
	var root_host: Node = Node.new()
	add_child_autofree(root_host)
	var watcher: Node = EndingWatcher.install(root_host)
	await get_tree().process_frame
	await _settle()
	assert_eq(_router.get_current_screen(), &"ending")
	assert_true(watcher.call(&"has_shown_ending") as bool)


func test_ending_requested_while_another_fade_runs_still_wins() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"dialogue", {"characterId": "ch_doctor"})
	await _settle()
	_router.fade_seconds = 0.1
	assert_eq(_router.goto(&"exploration"), OK, "Escape first: its fade starts")
	_publish(EndingFixtures.view_for("death").duplicate(true))
	assert_false(watcher.call(&"has_shown_ending") as bool, "requested is not shown")
	await _settle()
	_router.fade_seconds = 0.0
	assert_eq(_router.get_current_screen(), &"ending")
	assert_true(watcher.call(&"has_shown_ending") as bool)


func test_a_second_session_shows_its_own_ending_without_the_old_recap() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	_publish(EndingFixtures.view_for("time_up").duplicate(true))
	await _settle()
	var first: Ending = _screen() as Ending
	assert_eq(first.get_ending_id(), "time_up")
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	assert_false(first.has_recap(), "the old TruthRecap leaves with its session")
	assert_eq(first.get_ending_id(), "")
	assert_false(watcher.call(&"has_shown_ending") as bool)
	_backend.set_session_id("session-b")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_version = 0
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	_publish(EndingFixtures.view_for("madness").duplicate(true))
	await _settle()
	assert_eq(_router.get_current_screen(), &"ending")
	assert_eq((_screen() as Ending).get_ending_id(), "madness")

func test_switching_sessions_during_terminal_fade_drops_the_old_ending() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	_router.fade_seconds = 0.1
	_publish(EndingFixtures.view_for("death").duplicate(true))
	assert_eq(_router.get_terminal_screen(), &"ending", "A's ending is fading in")
	watch_signals(_router)

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_backend.set_session_id("session-b")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_version = 0
	_publish(Fixtures.load_view("mid").duplicate(true))
	assert_eq(_router.goto(&"exploration"), OK, "B's route must be available")
	await _settle()
	assert_eq(_router.get_current_screen(), &"exploration")
	assert_signal_emit_count(_router, "screen_changed", 1, "the old ending never mounts")
	assert_false(watcher.call(&"has_shown_ending") as bool)


func test_switching_sessions_discards_a_terminal_route_queued_behind_another_screen() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	_router.fade_seconds = 0.1
	assert_eq(_router.goto(&"case_board"), OK)
	_publish(EndingFixtures.view_for("death").duplicate(true))
	assert_eq(_router.get_terminal_screen(), &"ending", "A's ending is queued")

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_backend.set_session_id("session-b")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_version = 0
	_publish(Fixtures.load_view("mid").duplicate(true))
	await _settle()
	assert_eq(_router.get_current_screen(), &"case_board", "the queued ending never mounts")
	assert_eq(_router.get_terminal_screen(), &"")
	assert_false(watcher.call(&"has_shown_ending") as bool)


func test_new_ending_during_old_fade_in_releases_the_terminal_lock() -> void:
	var watcher: Node = EndingWatcher.new()
	add_child_autofree(watcher)
	_publish(Fixtures.load_view("mid").duplicate(true))
	_router.goto(&"exploration")
	await _settle()
	_router.fade_seconds = 0.2
	_publish(EndingFixtures.view_for("death").duplicate(true))
	await wait_until(func() -> bool: return _router.get_current_screen() == &"ending", 2.0)
	assert_true(_router.is_transitioning(), "A's ending mounted but its fade-in is still running")

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_backend.set_session_id("session-b")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_version = 0
	_publish(EndingFixtures.view_for("madness").duplicate(true))
	await _settle()
	assert_eq((_screen() as Ending).get_ending_id(), "madness")
	assert_eq(_router.get_terminal_screen(), &"")
	assert_eq(_router.goto(&"case_board", {"back": "ending"}), OK)
	await _settle()
	assert_eq(_router.get_current_screen(), &"case_board")
