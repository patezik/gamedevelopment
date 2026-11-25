extends GutTest

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const AudioDirectorScript = preload("res://src/autoload/audio_director.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")
const Fixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const Contract = preload("res://tests/contract/contract_support.gd")
const SCENE: String = "res://src/scenes/dialogue/dialogue.tscn"

var _backend: FakeBackend
var _store: GameStoreScript
var _audio: AudioDirectorScript
var _view: Dictionary


func before_each() -> void:
	_audio = get_node(^"/root/AudioDirector") as AudioDirectorScript
	_audio.bind_store(null)
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = get_node(^"/root/GameStore") as GameStoreScript
	_store.bind_backend(_backend)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_view = Fixtures.load_view("mid").duplicate(true)


func after_each() -> void:
	await get_tree().process_frame
	_store.bind_backend(get_node(^"/root/Backend") as BackendScript)
	_audio.bind_store(_store)


func test_preview_shows_topics_history_and_presentable_subjects() -> void:
	var screen: Control = _screen()
	if screen == null:
		return
	assert_eq((screen.get_node(^"%CharacterName") as Label).text, "Доктор Белов")
	assert_string_contains(_button(screen, ^"%Topics", 0).text, "13 мин")
	assert_string_contains(_history(screen), "Ключ от процедурной всегда лежит у меня в ящике.")
	(screen.get_node(^"%Present") as Button).button_pressed = true
	assert_string_contains(_button(screen, ^"%Subjects", 0).text, "25 мин")
	assert_string_contains(_button(screen, ^"%Subjects", 1).text, "время неизвестно")
	assert_true(_button(screen, ^"%Subjects", 0).disabled)
	assert_true(_backend.sent.is_empty())


func test_talk_waits_for_its_result_then_a_fresh_view() -> void:
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	var topic: Button = _button(screen, ^"%Topics", 0)
	topic.pressed.emit()
	topic.pressed.emit()
	_assert_sent({"type": "talk", "characterId": "ch_doctor", "topicId": "topic_whereabouts"})
	_result(true, "unrelated-request")
	_publish(2)
	assert_true(_button(screen, ^"%Topics", 0).disabled)
	assert_string_contains((screen.get_node(^"%Status") as Label).text, "Ожидание")
	_result(true)
	assert_true(_button(screen, ^"%Topics", 0).disabled, "result precedes the updated view")
	_publish(3)
	assert_false(_button(screen, ^"%Topics", 0).disabled)


func test_present_sends_evidence_and_contradiction_with_their_exact_wire_shape() -> void:
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	(screen.get_node(^"%Present") as Button).button_pressed = true
	_button(screen, ^"%Subjects", 0).pressed.emit()
	_assert_sent({
		"type": "interrogate", "characterId": "ch_doctor",
		"subject": {"type": "evidence", "clueId": "clue_logbook"},
	})
	_result(true)
	_publish(2)
	_button(screen, ^"%Subjects", 1).pressed.emit()
	var confirm: ConfirmationDialog = screen.get_node(^"%Confirm") as ConfirmationDialog
	assert_true(confirm.visible, "the player confirms a subject with an unknown cost")
	assert_eq(_backend.sent.size(), 1)
	confirm.confirmed.emit()
	_assert_sent({
		"type": "interrogate", "characterId": "ch_doctor",
		"subject": {"type": "contradiction", "contradictionId": "con_keys"},
	}, 2)


func test_history_shows_server_replies_in_order_even_with_identical_minutes() -> void:
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	var interaction: Dictionary = _view["interaction"]
	var history: Array = interaction["history"]
	# Three projected text replies. The wire format carries no outcome enum.
	history.append_array([
		{"speaker": "other", "text": "Да, ключ я отдавал.", "at": 1460},
		{"speaker": "other", "text": "Подождите, ключ взяли утром.", "at": 1460},
		{"speaker": "other", "text": "Я не буду отвечать.", "at": 1460},
	])
	assert_true(Contract.shape_problems(_view, Contract.schema("player-view.json"), "$").is_empty())
	_publish(2)
	var text: String = _history(screen)
	assert_true(text.find("Да, ключ я отдавал.") >= 0)
	assert_true(text.find("Подождите, ключ взяли утром.") > text.find("Да, ключ я отдавал."))
	assert_true(text.find("Я не буду отвечать.") > text.find("Подождите, ключ взяли утром."))
	_publish(3)
	assert_eq(_history(screen), text, "repeated snapshots do not duplicate lines")


func test_updated_subjects_invalidate_an_open_confirmation() -> void:
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	(screen.get_node(^"%Present") as Button).button_pressed = true
	_button(screen, ^"%Subjects", 1).pressed.emit()
	var confirm: ConfirmationDialog = screen.get_node(^"%Confirm") as ConfirmationDialog
	assert_true(confirm.visible)
	var interaction: Dictionary = _view["interaction"]
	interaction["presentable"] = []
	_publish(2)
	assert_false(confirm.visible)
	confirm.confirmed.emit()
	assert_true(_backend.sent.is_empty())


func test_history_reports_unresolved_server_templates_without_inventing_reactions() -> void:
	var interaction: Dictionary = _view["interaction"]
	interaction["history"] = [
		{"speaker": "other", "text": "testimony_whereWereYou_at", "at": 1460},
		{"speaker": "other", "text": "testimony_none", "at": 1460},
	]
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	assert_string_contains(_history(screen), "Текст показания недоступен.")
	assert_string_contains(_history(screen), "Собеседник ничего не сообщил.")
	assert_false(_history(screen).contains("testimony_"))


func test_nested_truth_is_rejected_without_replacing_the_visible_history() -> void:
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	var previous: String = _history(screen)
	var interaction: Dictionary = _view["interaction"]
	var history: Array = interaction["history"]
	history.append({"speaker": "other", "text": "Скрытая реплика", "at": 1460, "veracity": "lie"})
	_publish(2)
	assert_push_error("server-only field 'veracity'")
	assert_eq(_history(screen), previous)
	assert_eq(_store.get_state_version(), 1)


func test_rejection_reconnect_and_end_of_dialogue() -> void:
	_publish(1)
	var screen: Control = _screen({"characterId": "ch_doctor"})
	if screen == null:
		return
	_button(screen, ^"%Topics", 0).pressed.emit()
	_result(false)
	assert_string_contains((screen.get_node(^"%Error") as Label).text, "недоступно")
	assert_false(_button(screen, ^"%Topics", 0).disabled)
	_button(screen, ^"%Topics", 0).pressed.emit()
	_backend.change_state(BackendScript.ConnectionState.RETRYING)
	assert_true(_button(screen, ^"%Topics", 0).disabled)
	assert_string_contains((screen.get_node(^"%Status") as Label).text, "соединения")
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	assert_false(_button(screen, ^"%Topics", 0).disabled)
	_view.erase("interaction")
	_publish(2)
	assert_true(_history(screen).is_empty())
	assert_string_contains((screen.get_node(^"%Status") as Label).text, "завершён")
	assert_false((screen.get_node(^"%Back") as Button).disabled)


func test_route_opens_from_exploration_and_back_does_not_reopen_automatically() -> void:
	var router: SceneRouterScript = get_node(^"/root/SceneRouter") as SceneRouterScript
	assert_true(router.has_screen(&"dialogue"))
	if not router.has_screen(&"dialogue"):
		return
	var host: Control = Control.new()
	add_child_autofree(host)
	var old_fade: float = router.fade_seconds
	router.host = host
	router.fade_seconds = 0.0
	var open_view: Dictionary = _view.duplicate(true)
	_view.erase("interaction")
	var offers: Array = _view["availableActions"]
	offers.push_front({
		"action": {"type": "talk", "characterId": "ch_doctor", "topicId": "self"},
		"label": "Поговорить", "costPreview": {"min": 10, "max": 10},
	})
	_publish(1)
	router.goto(&"exploration")
	await _settle(router)
	var exploration: Node = host.get_child(0)
	var characters: VBoxContainer = exploration.get_node(^"%Characters") as VBoxContainer
	var row: Node = characters.get_child(0)
	(row.get_child(1) as Button).pressed.emit()
	_assert_sent({"type": "talk", "characterId": "ch_doctor", "topicId": "self"})
	_view = open_view
	_publish(2)
	assert_eq(router.get_current_screen(), &"exploration", "unrelated snapshot cannot open dialogue")
	_result(true)
	_publish(3)
	await _settle(router)
	assert_eq(router.get_current_screen(), &"dialogue")
	if router.get_current_screen() == &"dialogue":
		var dialogue: Node = host.get_child(0)
		(dialogue.get_node(^"%Back") as Button).pressed.emit()
		await _settle(router)
		assert_eq(router.get_current_screen(), &"exploration")
		_publish(4)
		await _settle(router)
		assert_eq(router.get_current_screen(), &"exploration")
		assert_eq(_backend.sent.size(), 1, "closing sends no action")
		exploration = host.get_child(0)
		characters = exploration.get_node(^"%Characters") as VBoxContainer
		row = characters.get_child(0)
		var resume: Button = row.get_child(row.get_child_count() - 1) as Button
		assert_eq(resume.text, "Продолжить разговор")
		resume.pressed.emit()
		await _settle(router)
		assert_eq(router.get_current_screen(), &"dialogue")
		assert_eq(_backend.sent.size(), 1, "returning to the conversation costs no action")
	router.host = null
	router.fade_seconds = old_fade


func _screen(params: Dictionary = {}) -> Control:
	var exists: bool = ResourceLoader.exists(SCENE, "PackedScene")
	assert_true(exists, "Dialogue scene is available")
	if not exists:
		return null
	var scene: PackedScene = load(SCENE) as PackedScene
	var screen: Control = scene.instantiate() as Control
	if not params.is_empty():
		screen.call(&"set_params", params)
	add_child_autofree(screen)
	return screen


func _button(screen: Control, container: NodePath, index: int) -> Button:
	return screen.get_node(container).get_child(index) as Button


func _history(screen: Control) -> String:
	return (screen.get_node(^"%History") as RichTextLabel).get_parsed_text()


func _publish(version: int) -> void:
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": version, "view": _view})


func _result(ok: bool, id: String = "") -> void:
	var request_id: String = id if not id.is_empty() else "desktop-%d" % _backend.sent.size()
	var result: Dictionary = {"ok": ok, "requestId": request_id, "minutesSpent": 0}
	if not ok:
		result["error"] = ProtocolConstants.ERROR_ACTION_NOT_AVAILABLE
	_backend.deliver(ProtocolConstants.MSG_ACTION_RESULT, result)


func _assert_sent(expected: Dictionary, count: int = 1) -> void:
	assert_eq(_backend.sent.size(), count)
	if _backend.sent.is_empty():
		return
	var action: Dictionary = _backend.sent.back()
	assert_eq(action, expected)
	assert_true(Contract.shape_problems(action, Contract.schema("player-action.json"), "$").is_empty())
	assert_eq(GameStoreScript.find_forbidden_key(action), "")


func _settle(router: SceneRouterScript) -> void:
	await wait_until(func() -> bool: return not router.is_transitioning(), 2.0)
