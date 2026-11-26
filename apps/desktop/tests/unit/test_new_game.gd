extends GutTest
## NewGame against a recording Backend: catalog loading and errors, random and entered seeds,
## one request per creation, REST failures, stale answers and the hand-over to Pairing without
## the token or a server-made seed leaving the session object.

const NewGame = preload("res://src/scenes/new_game/new_game.gd")
const Scene = preload("res://src/scenes/new_game/new_game.tscn")
const Format = preload("res://src/scenes/new_game/new_game_format.gd")
const FakeSessionBackend = preload("res://tests/unit/support/fake_session_backend.gd")
const FakeRouter = preload("res://tests/unit/support/fake_router.gd")

const SETTINGS_SCRATCH: String = "user://test_new_game_settings.cfg"
const SESSION_ID: String = "49a4ae5c-4174-416f-94c5-b8a7380636e5"
const TOKEN: String = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
const SCENARIOS: Array = [
	{"id": "sanatorium_winter", "title": "Санаторий «Сосновый бор»", "durationMinutes": 4320.0},
	{"id": "manor", "title": "Усадьба", "durationMinutes": 1440.0},
]

var backend: FakeSessionBackend
var router: FakeRouter
var screen: NewGame
var _saved_config_path: String


func before_each() -> void:
	_saved_config_path = Settings.config_path
	Settings.config_path = SETTINGS_SCRATCH
	PairingSession.clear()
	backend = FakeSessionBackend.new()
	add_child_autofree(backend)
	router = FakeRouter.new()
	add_child_autofree(router)


func after_each() -> void:
	Settings.config_path = _saved_config_path
	DirAccess.remove_absolute(ProjectSettings.globalize_path(SETTINGS_SCRATCH))
	PairingSession.clear()


func _open(params: Dictionary = {}) -> NewGame:
	screen = Scene.instantiate() as NewGame
	screen.user_args = PackedStringArray()
	screen.set_params(params)
	screen.bind_sources(backend, router)
	add_child_autofree(screen)
	return screen


func _open_ready() -> NewGame:
	_open()
	backend.answer(backend.last_call().id, 200, SCENARIOS)
	return screen


func _created_body() -> Dictionary:
	return {
		"sessionId": SESSION_ID,
		"desktopToken": TOKEN,
		"pairing": {
			"code": "K7M2QX", "expiresAt": 1795683501742.0,
			"qrPayload": "hs1:pair:192.168.1.20:7420:K7M2QX",
		},
	}


func _node(node_name: String) -> Control:
	return screen.find_child(node_name, true, false) as Control


func _create_button() -> Button:
	return _node("Create") as Button


func _text(node_name: String) -> String:
	return (_node(node_name) as Label).text


func _posts() -> Array[FakeSessionBackend.Call]:
	return backend.calls_to("/api/v1/sessions")


## Every string the screen shows.
func _visible_texts(node: Node) -> PackedStringArray:
	var texts: PackedStringArray = []
	if node is Label:
		texts.append((node as Label).text)
	elif node is LineEdit:
		texts.append((node as LineEdit).text)
	elif node is OptionButton:
		var option: OptionButton = node
		for index: int in range(option.item_count):
			texts.append(option.get_item_text(index))
	elif node is Button:
		texts.append((node as Button).text)
	for child: Node in node.get_children():
		texts.append_array(_visible_texts(child))
	return texts


func test_the_catalog_is_requested_from_the_default_server() -> void:
	_open()
	assert_eq(backend.calls.size(), 1)
	assert_eq(backend.last_call().url, Format.DEFAULT_ORIGIN + "/api/v1/scenarios")
	assert_eq(backend.last_call().method, HTTPClient.METHOD_GET)
	assert_eq(backend.last_call().token, "", "the catalog needs no credentials")
	assert_eq(screen.get_phase(), NewGame.Phase.LOADING)
	assert_eq(_text("Status"), NewGame.LOADING_TEXT)
	assert_true(_create_button().disabled)


func test_params_choose_another_server() -> void:
	_open({"server": "http://10.0.0.5:7499/"})
	assert_eq(screen.get_origin(), "http://10.0.0.5:7499")
	assert_eq(backend.last_call().url, "http://10.0.0.5:7499/api/v1/scenarios")


func test_scenarios_fill_the_list_and_enable_creation() -> void:
	_open_ready()
	var scenario: OptionButton = _node("Scenario") as OptionButton
	assert_eq(scenario.item_count, 2)
	assert_eq(scenario.get_item_text(0), "Санаторий «Сосновый бор» · 72 ч игрового времени")
	assert_eq(scenario.selected, 0)
	assert_eq(screen.get_phase(), NewGame.Phase.READY)
	assert_false(_create_button().disabled)
	assert_true((_node("RandomSeed") as CheckButton).button_pressed, "random seed by default")
	assert_false((_node("Seed") as LineEdit).editable)


func test_an_unreachable_server_can_be_retried() -> void:
	_open()
	backend.answer(backend.last_call().id, 0, null, HTTPRequest.RESULT_CANT_CONNECT)
	assert_eq(screen.get_phase(), NewGame.Phase.CATALOG_FAILED)
	assert_eq(_text("Error"), Format.CATALOG_UNREACHABLE % Format.DEFAULT_ORIGIN)
	assert_true(_create_button().disabled)
	var reload: Button = _node("Reload") as Button
	assert_true(reload.visible)
	reload.pressed.emit()
	assert_eq(backend.calls.size(), 2)
	assert_true(reload.disabled, "one catalog request at a time")
	reload.pressed.emit()
	assert_eq(backend.calls.size(), 2)
	backend.answer(backend.last_call().id, 200, SCENARIOS)
	assert_eq(screen.get_phase(), NewGame.Phase.READY)
	assert_eq(_text("Error"), "")
	assert_false(reload.visible)


func test_an_empty_or_malformed_catalog_is_an_error() -> void:
	_open()
	backend.answer(backend.last_call().id, 200, [{"id": 1}])
	assert_eq(screen.get_phase(), NewGame.Phase.CATALOG_FAILED)
	assert_eq(_text("Error"), Format.CATALOG_EMPTY)
	(_node("Reload") as Button).pressed.emit()
	backend.answer(backend.last_call().id, 503, null)
	assert_eq(_text("Error"), Format.CATALOG_FAILED % 503)


func test_a_random_seed_is_not_sent_and_creation_posts_once() -> void:
	_open_ready()
	(_node("Scenario") as OptionButton).select(1)
	_create_button().pressed.emit()
	_create_button().pressed.emit()
	assert_false(screen.create_session(), "a creation in flight blocks another")
	assert_eq(_posts().size(), 1)
	var post: FakeSessionBackend.Call = _posts()[0]
	assert_eq(post.method, HTTPClient.METHOD_POST)
	assert_eq(post.url, Format.DEFAULT_ORIGIN + "/api/v1/sessions")
	var body: Dictionary = JSON.parse_string(str(backend.bodies[post.id]))
	assert_eq(body, {"scenarioId": "manor", "locale": Settings.get_locale()})
	assert_eq(screen.get_phase(), NewGame.Phase.CREATING)
	assert_eq(_text("Status"), NewGame.CREATING_TEXT)
	assert_true(_create_button().disabled)
	assert_true((_node("Scenario") as OptionButton).disabled)
	assert_true((_node("RandomSeed") as CheckButton).disabled)


func test_the_interface_language_is_sent_to_the_server() -> void:
	var saved: String = Settings.get_locale()
	_open_ready()
	Settings._apply_locale("en")
	assert_true(screen.create_session())
	var body: Dictionary = JSON.parse_string(str(backend.bodies[_posts()[0].id]))
	assert_eq(str(body.get("locale")), "en")
	Settings._apply_locale(saved)


func test_language_picker_lists_supported_locales_with_native_names() -> void:
	_open_ready()
	var picker: OptionButton = _node("Language") as OptionButton
	assert_eq(picker.item_count, Settings.SUPPORTED_LOCALES.size())
	assert_eq(picker.get_item_text(0), "Русский")
	assert_eq(picker.get_item_text(1), "English")
	assert_eq(picker.get_item_text(picker.selected), Localization.text("language." + Settings.get_locale()))


func test_picking_english_sets_the_locale_redraws_and_is_sent_and_saved() -> void:
	var saved: String = Settings.get_locale()
	Settings.set_locale("ru")
	_open_ready()
	var picker: OptionButton = _node("Language") as OptionButton
	assert_eq(_text("LanguageHeading"), "Язык")
	picker.select(1)
	picker.item_selected.emit(1)
	assert_eq(Settings.get_locale(), "en")
	assert_eq(TranslationServer.get_locale(), "en")
	assert_eq(_text("LanguageHeading"), "Language")
	assert_eq(picker.selected, 1)
	var config: ConfigFile = ConfigFile.new()
	assert_eq(config.load(Settings.config_path), OK)
	assert_eq(str(config.get_value(Settings.SECTION_GENERAL, Settings.KEY_LOCALE, "")), "en")
	assert_true(screen.create_session())
	var body: Dictionary = JSON.parse_string(str(backend.bodies[_posts()[0].id]))
	assert_eq(str(body.get("locale")), "en")
	Settings.set_locale(saved)


func test_picking_russian_again_restores_the_locale() -> void:
	var saved: String = Settings.get_locale()
	Settings.set_locale("en")
	_open_ready()
	var picker: OptionButton = _node("Language") as OptionButton
	assert_eq(picker.selected, 1)
	picker.select(0)
	picker.item_selected.emit(0)
	assert_eq(Settings.get_locale(), "ru")
	assert_eq(_text("LanguageHeading"), "Язык")
	assert_true(screen.create_session())
	var body: Dictionary = JSON.parse_string(str(backend.bodies[_posts()[0].id]))
	assert_eq(str(body.get("locale")), "ru")
	Settings.set_locale(saved)


func test_an_entered_seed_is_validated_and_sent() -> void:
	_open_ready()
	var random: CheckButton = _node("RandomSeed") as CheckButton
	var seed: LineEdit = _node("Seed") as LineEdit
	random.button_pressed = false
	assert_true(seed.editable)
	assert_true(_create_button().disabled, "an empty seed")
	assert_eq(_text("SeedError"), NewGame.SEED_REQUIRED)
	seed.text = "seed#1"
	seed.text_changed.emit(seed.text)
	assert_true(_create_button().disabled)
	assert_eq(_text("SeedError"), Format.SEED_INVALID)
	assert_false(screen.create_session())
	assert_eq(_posts().size(), 0)
	seed.text = "winter-42"
	seed.text_changed.emit(seed.text)
	assert_false(_create_button().disabled)
	assert_eq(_text("SeedError"), "")
	seed.text_submitted.emit(seed.text)
	assert_eq(_posts().size(), 1)
	var body: Dictionary = JSON.parse_string(str(backend.bodies[_posts()[0].id]))
	assert_eq(body, {"scenarioId": "sanatorium_winter", "seed": "winter-42", "locale": Settings.get_locale()})
	assert_false(seed.editable, "locked while the case is generated")


func test_rest_errors_unlock_the_form_and_allow_a_new_request() -> void:
	_open_ready()
	var cases: Array = [
		[HTTPRequest.RESULT_SUCCESS, 422, {"error": {"code": "GENERATION_UNSOLVABLE", "message": ""}}, Format.CREATE_UNSOLVABLE],
		[HTTPRequest.RESULT_SUCCESS, 400, {"error": {"code": "INVALID_MESSAGE", "message": ""}}, Format.CREATE_INVALID],
		[HTTPRequest.RESULT_SUCCESS, 500, {"error": {"code": "INTERNAL", "message": ""}}, Format.CREATE_INTERNAL],
		[HTTPRequest.RESULT_TIMEOUT, 0, null, Format.CREATE_UNREACHABLE],
		[HTTPRequest.RESULT_SUCCESS, 201, {"sessionId": SESSION_ID}, Format.CREATE_BAD_ANSWER],
	]
	for entry: Array in cases:
		assert_true(screen.create_session())
		var post: FakeSessionBackend.Call = _posts().back()
		backend.answer(post.id, entry[1] as int, entry[2], entry[0] as int)
		assert_eq(_text("Error"), str(entry[3]))
		assert_eq(screen.get_phase(), NewGame.Phase.READY)
		assert_false(_create_button().disabled)
	assert_eq(_posts().size(), cases.size())
	assert_null(PairingSession.current())
	assert_eq(backend.connects.size(), 0)
	assert_eq(router.routes.size(), 0)
	assert_true(screen.create_session(), "a new attempt clears the error")
	assert_eq(_text("Error"), "")


func test_a_vanished_scenario_reloads_the_catalog() -> void:
	_open_ready()
	screen.create_session()
	backend.answer(_posts()[0].id, 404, {"error": {"code": "SCENARIO_NOT_FOUND", "message": ""}})
	assert_eq(_text("Error"), Format.CREATE_SCENARIO_GONE)
	assert_eq(backend.calls_to("/api/v1/scenarios").size(), 2)
	backend.answer(backend.last_call().id, 200, [SCENARIOS[1]])
	assert_eq((_node("Scenario") as OptionButton).item_count, 1)
	assert_eq(screen.get_phase(), NewGame.Phase.READY)


func test_answers_to_other_requests_are_ignored() -> void:
	_open_ready()
	screen.create_session()
	backend.answer(9999, 201, _created_body())
	backend.answer(backend.calls[0].id, 200, [])
	assert_eq(screen.get_phase(), NewGame.Phase.CREATING)
	assert_null(PairingSession.current())


func test_a_created_session_goes_to_pairing_without_its_secrets() -> void:
	_open_ready()
	screen.create_session()
	backend.answer(_posts()[0].id, 201, _created_body())
	var session: PairingSession = PairingSession.current()
	assert_not_null(session)
	assert_eq(session.session_id, SESSION_ID)
	assert_eq(session.origin, Format.DEFAULT_ORIGIN)
	assert_eq(session.code, "K7M2QX")
	assert_eq(backend.connects, [{"url": "ws://127.0.0.1:7420/ws", "token": TOKEN}])
	assert_eq(router.routes.size(), 1)
	assert_eq(router.last_screen(), NewGame.PAIRING_SCREEN)
	var params: Dictionary = router.routes[0]["params"]
	assert_eq(params, {}, "nothing secret travels in router params")
	assert_eq(screen.get_phase(), NewGame.Phase.DONE)
	assert_true(_create_button().disabled)
	assert_false(screen.create_session(), "no second session from the same screen")
	for text: String in _visible_texts(screen):
		assert_false(text.contains(TOKEN), "the token is never shown")


func test_leaving_the_screen_drops_queued_requests() -> void:
	_open()
	var catalog: int = backend.last_call().id
	remove_child(screen)
	assert_has(backend.canceled, catalog)
	screen.free()
