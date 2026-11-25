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
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_router = get_node(^"/root/SceneRouter") as SceneRouterScript
	_host = Control.new()
	add_child_autofree(_host)
	_old_fade = _router.fade_seconds
	_router.host = _host
	_router.fade_seconds = 0.0
	_version = 0


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
	assert_false(watcher.call(&"has_opened_ending") as bool)
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
	assert_false(watcher.call(&"has_opened_ending") as bool, "a new session may end again")


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
