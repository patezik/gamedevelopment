extends GutTest

const ExplorationScene = preload("res://src/scenes/exploration/exploration.tscn")
const Exploration = preload("res://src/scenes/exploration/exploration.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const LocationMap = preload("res://src/ui/location_map.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")

var _backend: FakeBackend
var _store: GameStoreScript


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)


## A screen mounted like SceneRouter does it (params before _ready), bound to the test store.
func _screen(params: Dictionary = {}) -> Exploration:
	var screen: Exploration = ExplorationScene.instantiate() as Exploration
	screen.set_params(params)
	screen.bind_store(_store)
	add_child_autofree(screen)
	return screen


## A screen run on its own, as from the editor: no params at all.
func _standalone_screen(store: GameStoreScript) -> Exploration:
	var screen: Exploration = ExplorationScene.instantiate() as Exploration
	screen.bind_store(store)
	add_child_autofree(screen)
	return screen


func _fixture(fixture_name: String) -> Dictionary:
	var view: Dictionary = PreviewFixtures.load_view(fixture_name)
	assert_false(view.is_empty(), "fixture %s loads" % fixture_name)
	return view


func _part(screen: Exploration, unique_name: String) -> Node:
	return screen.get_node(NodePath("%" + unique_name))


func _label(screen: Exploration, unique_name: String) -> Label:
	return _part(screen, unique_name) as Label


func _texts(node: Node) -> PackedStringArray:
	var found: PackedStringArray = PackedStringArray()
	if node is Label:
		found.append((node as Label).text)
	elif node is Button:
		found.append((node as Button).text)
	for child: Node in node.get_children():
		found.append_array(_texts(child))
	return found


func _buttons(node: Node) -> Array[Button]:
	var found: Array[Button] = []
	if node is Button and node.has_meta(Exploration.META_ACTION):
		found.append(node as Button)
	for child: Node in node.get_children():
		found.append_array(_buttons(child))
	return found


func _button(screen: Exploration, fragment: String) -> Button:
	for button: Button in _buttons(screen):
		if button.text.contains(fragment):
			return button
	fail_test("no action button with '%s'" % fragment)
	return null


func _has_text(node: Node, fragment: String) -> bool:
	for text: String in _texts(node):
		if text.contains(fragment):
			return true
	return false


# --- smoke and preview mode -------------------------------------------------------------------


func test_scene_loads_and_instantiates() -> void:
	var screen: Exploration = ExplorationScene.instantiate() as Exploration
	assert_not_null(screen)
	screen.free()


func test_standalone_scene_previews_a_fixture_without_a_server() -> void:
	var offline_store: GameStoreScript = GameStoreScript.new()
	add_child_autofree(offline_store)
	offline_store.bind_backend(null)

	var screen: Exploration = _standalone_screen(offline_store)

	assert_true(screen.is_preview())
	assert_eq(_label(screen, "LocationName").text, "Процедурная")
	assert_string_contains(_label(screen, "Status").text, "Предпросмотр")
	assert_gt(_buttons(screen).size(), 0, "preview shows the fixture's actions")


func test_preview_action_without_a_server_reports_the_failure() -> void:
	var offline_store: GameStoreScript = GameStoreScript.new()
	add_child_autofree(offline_store)
	offline_store.bind_backend(null)
	var screen: Exploration = _standalone_screen(offline_store)

	_button(screen, "Изучить раковину").pressed.emit()

	assert_eq(_label(screen, "Error").text, "Нет соединения с сервером. Backend is not available")
	assert_false(screen.is_awaiting_result())
	assert_false(_button(screen, "Изучить раковину").disabled, "buttons unlock after the failure")


func test_route_param_selects_the_preview_fixture() -> void:
	var screen: Exploration = _screen({"preview": "start"})

	assert_true(screen.is_preview())
	assert_eq(_label(screen, "LocationName").text, "Вестибюль санатория")


func test_unknown_preview_fixture_shows_an_honest_empty_state() -> void:
	var screen: Exploration = _screen({"preview": "missing"})

	assert_push_warning("unknown fixture")
	assert_false((_part(screen, "Content") as Control).visible)
	assert_string_contains(_label(screen, "Status").text, "не загружена")


func test_live_view_replaces_the_preview() -> void:
	var screen: Exploration = _standalone_screen(_store)
	assert_true(screen.is_preview())

	_store.set_view(_fixture("start"), 1)

	assert_false(screen.is_preview())
	assert_eq(_label(screen, "LocationName").text, "Вестибюль санатория")
	assert_eq(_label(screen, "Status").text, "")


# --- rendering ----------------------------------------------------------------------------------


func test_routed_screen_without_a_view_waits_for_the_server() -> void:
	var screen: Exploration = _screen()

	assert_false(screen.is_preview(), "a routed screen never invents a preview")
	assert_false((_part(screen, "Content") as Control).visible)
	assert_eq(_label(screen, "Status").text, Exploration.NO_VIEW_TEXT)


func test_renders_location_hotspots_characters_and_exits() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()

	assert_eq(_label(screen, "LocationName").text, "Вестибюль санатория")
	assert_string_contains(_label(screen, "LocationDescription").text, "Холодный свет")
	assert_eq(_label(screen, "Lighting").text, "Светло")
	var background: ColorRect = _part(screen, "Background") as ColorRect
	assert_eq(background.color, Exploration._placeholder_color("loc_lobby", "bright"))
	assert_ne(background.color, Exploration._placeholder_color("loc_corridor", "bright"))

	var hotspots: Node = _part(screen, "Hotspots")
	assert_eq(hotspots.get_child_count(), 2)
	assert_true(_has_text(hotspots, "Стойка регистрации"))
	assert_true(_has_text(hotspots, "Изучить стойку · 5 мин"), "hotspot action next to it")

	var characters: Node = _part(screen, "Characters")
	assert_eq(characters.get_child_count(), 2)
	assert_true(_has_text(characters, "Дежурная медсестра — напряжена"))
	assert_true(_has_text(characters, "Поговорить с медсестрой · 10 мин"))

	var exits: Node = _part(screen, "Exits")
	assert_eq(exits.get_child_count(), 3)
	assert_true(_has_text(exits, "Главный коридор · путь ≈ 3 мин"))
	assert_true(_has_text(exits, "Перейти · 3 мин"))
	assert_true(_has_text(exits, "закрыто: Дверь заперта"))
	assert_true(_has_text(exits, Exploration.EXIT_UNAVAILABLE_TEXT), "an exit without a move")

	var actions: Node = _part(screen, "Actions")
	assert_true(_has_text(actions, "Осмотреть вестибюль · 15 мин"))
	assert_true(_has_text(actions, "Отдохнуть 1 час · 60 мин"))
	assert_eq(_buttons(screen).size(), 6, "each available action is shown exactly once")


func test_cost_ranges_and_examined_marks_are_shown() -> void:
	_store.set_view(_fixture("mid"), 1)
	var screen: Exploration = _screen()

	assert_true(_has_text(screen, "Вскрыть замок шкафчика · 25–38 мин"))
	assert_true(_has_text(_part(screen, "Hotspots"), "Шкаф с лекарствами (осмотрено)"))
	assert_true(_has_text(_part(screen, "Characters"), "Предъявить журнал выдачи ключей · 25 мин"))


func test_view_changed_updates_the_screen_and_the_map() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()

	_store.set_view(_fixture("capture"), 2)

	assert_eq(_label(screen, "LocationName").text, "Главный коридор")
	var map: LocationMap = _part(screen, "Map") as LocationMap
	var current: Array[String] = []
	for box: Label in map.location_boxes():
		var is_current: bool = box.get_meta(LocationMap.META_CURRENT)
		if is_current:
			current.append(str(box.get_meta(LocationMap.META_LOCATION_ID)))
	assert_eq(current, ["loc_corridor"] as Array[String])
	assert_true(screen.get_known_map().is_visited("loc_lobby"), "the map keeps visited places")
	assert_true(screen.get_known_map().has_link("loc_lobby", "loc_corridor"))


func test_empty_and_partial_views_render_placeholders() -> void:
	_store.set_view({"clock": {"time": "08:00"}}, 1)
	var screen: Exploration = _screen()
	assert_false((_part(screen, "Content") as Control).visible, "no location, nothing to show")

	_store.set_view({"location": {"id": "loc_x"}}, 2)
	assert_true((_part(screen, "Content") as Control).visible)
	assert_eq(_label(screen, "LocationName").text, Exploration.UNTITLED_TEXT)
	assert_true(_has_text(_part(screen, "Hotspots"), Exploration.NO_HOTSPOTS_TEXT))
	assert_true(_has_text(_part(screen, "Characters"), Exploration.NO_CHARACTERS_TEXT))
	assert_true(_has_text(_part(screen, "Exits"), Exploration.NO_EXITS_TEXT))
	assert_true(_has_text(_part(screen, "Actions"), Exploration.NO_ACTIONS_TEXT))

	var malformed: Dictionary = {
		"location": {"id": "loc_y", "name": "Склад", "hotspots": "oops", "exits": [1, "x"]},
		"presentCharacters": null,
		"availableActions": [
			"bad",
			{"label": "Без действия"},
			{"action": {"type": "call", "contactId": "c1"}, "label": "Позвонить"},
			{"action": {"type": "wait", "minutes": 15}, "label": "Ждать", "costPreview": {"min": 9}},
		],
	}
	_store.set_view(malformed, 3)
	assert_eq(_label(screen, "LocationName").text, "Склад")
	var buttons: Array[Button] = _buttons(screen)
	assert_eq(buttons.size(), 1, "only a desktop action from the view becomes a button")
	assert_eq(buttons[0].text, "Ждать · время неизвестно")


# --- actions ------------------------------------------------------------------------------------


func test_action_is_sent_through_the_store_unchanged() -> void:
	var view: Dictionary = _fixture("start")
	_store.set_view(view, 1)
	var screen: Exploration = _screen()

	_button(screen, "Перейти · 3 мин").pressed.emit()

	assert_eq(_backend.sent.size(), 1)
	assert_eq(_backend.sent[0], {"type": "move", "locationId": "loc_corridor"})
	assert_true(screen.is_awaiting_result())


func test_buttons_lock_until_the_next_view() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()

	_button(screen, "Изучить стойку").pressed.emit()
	for button: Button in _buttons(screen):
		assert_true(button.disabled, "%s is locked while the action is in flight" % button.text)
	_button(screen, "Осмотреть вестибюль").pressed.emit()
	assert_eq(_backend.sent.size(), 1, "no second action while one is pending")

	_store.set_view(_fixture("start"), 2)

	assert_false(screen.is_awaiting_result())
	assert_false(_button(screen, "Осмотреть вестибюль").disabled)


func test_blocked_action_is_disabled_and_never_sent() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()

	var blocked: Button = _button(screen, "Перейти · 4 мин")
	assert_true(blocked.disabled)
	assert_string_contains(blocked.text, "Дверь заперта")
	blocked.pressed.emit()

	assert_eq(_backend.sent.size(), 0)


func test_long_action_waits_for_confirmation() -> void:
	_store.set_view(_fixture("mid"), 1)
	var screen: Exploration = _screen()
	var dialog: ConfirmationDialog = _part(screen, "Confirm") as ConfirmationDialog

	_button(screen, "Отдохнуть 2 часа").pressed.emit()

	assert_true(dialog.visible)
	assert_string_contains(dialog.dialog_text, "150 мин")
	assert_eq(_backend.sent.size(), 0, "nothing is sent before the player confirms")

	dialog.get_ok_button().pressed.emit()

	assert_eq(_backend.sent.size(), 1)
	assert_eq(str(_backend.sent[0].get("type")), ProtocolConstants.ACTION_REST)


func test_cancelled_confirmation_sends_nothing() -> void:
	_store.set_view(_fixture("mid"), 1)
	var screen: Exploration = _screen()
	var dialog: ConfirmationDialog = _part(screen, "Confirm") as ConfirmationDialog

	_button(screen, "Отдохнуть 2 часа").pressed.emit()
	dialog.get_cancel_button().pressed.emit()
	dialog.confirmed.emit()

	assert_eq(_backend.sent.size(), 0)
	assert_false(screen.is_awaiting_result())


func test_short_action_needs_no_confirmation() -> void:
	_store.set_view(_fixture("mid"), 1)
	var screen: Exploration = _screen()

	_button(screen, "Подождать 30 минут").pressed.emit()

	assert_false((_part(screen, "Confirm") as ConfirmationDialog).visible)
	assert_eq(_backend.sent.size(), 1)


func test_action_failed_is_shown_and_unlocks_the_buttons() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()
	_button(screen, "Изучить стойку").pressed.emit()

	_backend.deliver(
		ProtocolConstants.MSG_ACTION_RESULT,
		{"requestId": "c-1", "ok": false, "error": ProtocolConstants.ERROR_ACTION_BLOCKED},
	)

	assert_eq(_label(screen, "Error").text, "Действие заблокировано.")
	assert_false(screen.is_awaiting_result())
	assert_false(_button(screen, "Изучить стойку").disabled)


func test_server_error_message_is_appended_and_cleared_by_a_new_view() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()

	_backend.deliver(
		ProtocolConstants.MSG_ERROR,
		{"requestId": "c-2", "code": "SOMETHING_NEW", "message": "details"},
	)
	assert_eq(_label(screen, "Error").text, "Не удалось выполнить действие (SOMETHING_NEW). details")

	_store.set_view(_fixture("start"), 2)
	assert_eq(_label(screen, "Error").text, "")


func test_session_end_clears_the_screen_and_the_map() -> void:
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()
	_button(screen, "Изучить стойку").pressed.emit()

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)

	assert_false(screen.is_awaiting_result())
	assert_false((_part(screen, "Content") as Control).visible)
	assert_true(screen.get_known_map().is_empty())


# --- no hidden data -----------------------------------------------------------------------------


func test_view_with_server_only_truth_never_reaches_the_screen() -> void:
	_store.set_view(_fixture("start"), 1)
	var screen: Exploration = _screen()
	var leaked: Dictionary = _fixture("mid").duplicate(true)
	leaked["truth"] = {"culprit": "ch_doctor"}

	_store.set_view(leaked, 2)

	assert_push_error("truth")
	assert_eq(_label(screen, "LocationName").text, "Вестибюль санатория", "the old view stays")


func test_screen_refuses_a_leaked_view_on_its_own() -> void:
	var screen: Exploration = _screen()
	var leaked: Dictionary = _fixture("start").duplicate(true)
	var location: Dictionary = leaked["location"]
	location["hotspots"] = [{"id": "hs_x", "name": "Тайник", "examined": false, "veracity": false}]

	screen._show(leaked)

	assert_push_error("veracity")
	assert_false((_part(screen, "Content") as Control).visible)
	assert_false(_has_text(screen, "Тайник"))


func test_only_exploration_data_is_displayed() -> void:
	_store.set_view(_fixture("mid"), 1)
	var screen: Exploration = _screen()

	var hidden: Array[String] = [
		# case board, dialogue history and inventory belong to other screens
		"Порванная записка",
		"Ключ от процедурной всегда лежит у меня в ящике",
		"Где вы были ночью?",
		"Фонарь",
		# internal ids are never shown
		"hs_sink",
		"ch_doctor",
		"clue_logbook",
		"loc_infirmary",
		"portrait_doctor_01",
	]
	for text: String in _texts(screen):
		for fragment: String in hidden:
			assert_false(text.contains(fragment), "'%s' shows '%s'" % [text, fragment])


# --- navigation ---------------------------------------------------------------------------------


func test_scene_router_registers_the_exploration_screen() -> void:
	var router: SceneRouterScript = SceneRouterScript.new()
	add_child_autofree(router)
	assert_true(router.has_screen(&"exploration"))


func test_scene_router_mounts_exploration_with_its_params() -> void:
	var host: Node = Node.new()
	add_child_autofree(host)
	var router: SceneRouterScript = SceneRouterScript.new()
	add_child_autofree(router)
	router.host = host
	router.fade_seconds = 0.0

	assert_eq(router.goto(&"exploration", {"preview": "start"}), OK)
	await wait_until(func() -> bool: return not router.is_transitioning(), 2.0)

	assert_eq(router.get_current_screen(), &"exploration")
	assert_eq(host.get_child_count(), 1)
	var screen: Exploration = host.get_child(0) as Exploration
	assert_not_null(screen, "the mounted node is the Exploration screen")
	assert_true(screen.is_preview())
	var location: Dictionary = screen.get_view().get("location", {})
	assert_eq(str(location.get("id")), "loc_lobby")
