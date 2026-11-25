extends GutTest
## CaseBoard (godot-client.md §4.2): sections, filter by character, markSuspicion, view updates,
## empty and partial data, the 20+ clue fixture and the absence of server-only data.

const CaseBoardScene = preload("res://src/scenes/case_board/case_board.tscn")
const CaseBoard = preload("res://src/scenes/case_board/case_board.gd")
const CaseBoardFixtures = preload("res://src/scenes/case_board/case_board_fixtures.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")

var _backend: FakeBackend
var _store: GameStoreScript


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)


## A board mounted like SceneRouter does it (params before _ready), bound to the test store.
func _board(params: Dictionary = {}) -> CaseBoard:
	var board: CaseBoard = CaseBoardScene.instantiate() as CaseBoard
	board.set_params(params)
	board.bind_store(_store)
	add_child_autofree(board)
	return board


## A board with [param view] delivered through the store as version [param version].
func _live_board(view: Dictionary, version: int = 1) -> CaseBoard:
	assert_true(_store.set_view(view, version), "the store accepts the view")
	return _board()


func _fixture(fixture_name: String) -> Dictionary:
	var view: Dictionary = PreviewFixtures.load_view(fixture_name)
	assert_false(view.is_empty(), "fixture %s loads" % fixture_name)
	return view


## A writable deep copy of [param view] with `caseBoard` fields replaced by [param board].
func _with_board(view: Dictionary, board: Dictionary) -> Dictionary:
	var copy: Dictionary = view.duplicate(true)
	var case_board: Dictionary = (copy["caseBoard"] as Dictionary).duplicate(true)
	for key: Variant in board:
		case_board[key] = board[key]
	copy["caseBoard"] = case_board
	return copy


func _section(board: CaseBoard, section: CaseBoard.Section) -> VBoxContainer:
	return board.get_section(section)


func _cards(board: CaseBoard, section: CaseBoard.Section) -> Array[PanelContainer]:
	var found: Array[PanelContainer] = []
	for child: Node in _section(board, section).get_children():
		if child is PanelContainer:
			found.append(child as PanelContainer)
	return found


func _texts(node: Node) -> PackedStringArray:
	var found: PackedStringArray = PackedStringArray()
	if node is Label:
		found.append((node as Label).text)
	elif node is Button:
		found.append((node as Button).text)
	elif node is LineEdit:
		found.append((node as LineEdit).text)
	for child: Node in node.get_children():
		found.append_array(_texts(child))
	return found


func _has_text(node: Node, fragment: String) -> bool:
	for text: String in _texts(node):
		if text.contains(fragment):
			return true
	return false


func _label(board: CaseBoard, unique_name: String) -> Label:
	return board.get_node(NodePath("%" + unique_name)) as Label


func _tabs(board: CaseBoard) -> TabContainer:
	return board.get_node(^"%Tabs") as TabContainer


func _level_button(board: CaseBoard, character_id: String, level: String) -> Button:
	for card: PanelContainer in _cards(board, CaseBoard.Section.PERSONS):
		for button: Button in _find_buttons(card):
			if (
				button.get_meta(CaseBoard.META_CHARACTER, "") == character_id
				and button.get_meta(CaseBoard.META_LEVEL, "") == level
			):
				return button
	fail_test("no suspicion button %s/%s" % [character_id, level])
	return null


func _note_edit(board: CaseBoard, character_id: String) -> LineEdit:
	for card: PanelContainer in _cards(board, CaseBoard.Section.PERSONS):
		for edit: LineEdit in _find_edits(card):
			if edit.get_meta(CaseBoard.META_CHARACTER, "") == character_id:
				return edit
	fail_test("no note field for %s" % character_id)
	return null


func _find_buttons(node: Node) -> Array[Button]:
	var found: Array[Button] = []
	if node is Button and node.has_meta(CaseBoard.META_LEVEL):
		found.append(node as Button)
	for child: Node in node.get_children():
		found.append_array(_find_buttons(child))
	return found


func _find_edits(node: Node) -> Array[LineEdit]:
	var found: Array[LineEdit] = []
	if node is LineEdit:
		found.append(node as LineEdit)
	for child: Node in node.get_children():
		found.append_array(_find_edits(child))
	return found


# --- smoke and preview ------------------------------------------------------------------------


func test_scene_loads_instantiates_and_is_a_router_screen() -> void:
	var board: CaseBoard = CaseBoardScene.instantiate() as CaseBoard
	assert_not_null(board)
	board.free()
	assert_true(SceneRouterScript.SCREENS.has(&"case_board"))
	assert_eq(str(SceneRouterScript.SCREENS[&"case_board"]), "res://src/scenes/case_board/case_board.tscn")


func test_router_mounts_the_board_with_params() -> void:
	var router: SceneRouterScript = SceneRouterScript.new()
	router.fade_seconds = 0.0
	add_child_autofree(router)
	var host: Node = Node.new()
	add_child_autofree(host)
	router.host = host
	watch_signals(router)

	assert_eq(router.goto(&"case_board", {"preview": "mid", "back": "exploration"}), OK)
	await wait_for_signal(router.screen_changed, 2.0)

	assert_eq(router.get_current_screen(), &"case_board")
	var board: CaseBoard = host.get_child(0) as CaseBoard
	assert_not_null(board, "the mounted screen is the case board")
	assert_true(board.is_preview())
	assert_true((board.get_node(^"%Back") as Button).visible, "the back param shows the back button")


func test_standalone_board_previews_a_fixture_without_a_server() -> void:
	var offline_store: GameStoreScript = GameStoreScript.new()
	add_child_autofree(offline_store)
	offline_store.bind_backend(null)
	var board: CaseBoard = CaseBoardScene.instantiate() as CaseBoard
	board.bind_store(offline_store)
	add_child_autofree(board)

	assert_true(board.is_preview())
	assert_string_contains(_label(board, "Status").text, "Предпросмотр")
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 5)
	assert_false((board.get_node(^"%Back") as Button).visible, "no back button without the param")


func test_large_preview_param_renders_the_big_fixture() -> void:
	var board: CaseBoard = _board({"preview": "large"})

	assert_true(board.is_preview())
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), CaseBoardFixtures.DEFAULT_CLUE_COUNT)


func test_unknown_preview_shows_an_honest_empty_state() -> void:
	var board: CaseBoard = _board({"preview": "missing"})

	assert_push_warning("unknown fixture")
	assert_false(_tabs(board).visible)
	assert_string_contains(_label(board, "Status").text, "не загружена")


# --- sections ---------------------------------------------------------------------------------


func test_all_sections_show_the_case_board_of_the_view() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	var tabs: TabContainer = _tabs(board)

	assert_true(tabs.visible)
	assert_eq(tabs.get_tab_count(), 5)
	assert_eq(tabs.get_tab_title(CaseBoard.Section.CLUES), "Улики (5)")
	assert_eq(tabs.get_tab_title(CaseBoard.Section.STATEMENTS), "Показания (2)")
	assert_eq(tabs.get_tab_title(CaseBoard.Section.CONTRADICTIONS), "Противоречия (1)")
	assert_eq(tabs.get_tab_title(CaseBoard.Section.PERSONS), "Персоны интереса (2)")
	assert_eq(tabs.get_tab_title(CaseBoard.Section.TIMELINE), "Хронология (2)")

	var clues: VBoxContainer = _section(board, CaseBoard.Section.CLUES)
	assert_true(_has_text(clues, "Порванная записка"))
	assert_true(_has_text(clues, "Документ · День 1, 18:40 · Процедурная · сохранена на телефоне"))
	assert_true(_has_text(clues, "не сохранена на телефоне"), "the voicemail is not captured")

	var statements: VBoxContainer = _section(board, CaseBoard.Section.STATEMENTS)
	assert_true(_has_text(statements, "Дежурная медсестра"), "speaker named from the persons of interest")
	assert_true(_has_text(statements, "День 1, 20:40"))

	var contradictions: VBoxContainer = _section(board, CaseBoard.Section.CONTRADICTIONS)
	assert_true(_has_text(contradictions, "Опровергает: Журнал выдачи ключей"))
	assert_true(_has_text(contradictions, "Показание: Доктор Белов:"))

	var persons: VBoxContainer = _section(board, CaseBoard.Section.PERSONS)
	assert_true(_has_text(persons, "Доктор Белов — персона интереса"))
	assert_true(_has_text(persons, "Связанные улики: Журнал выдачи ключей"))
	assert_true(_level_button(board, "ch_doctor", "possible").button_pressed, "the mark the view holds")
	assert_false(_level_button(board, "ch_doctor", "prime").button_pressed)
	assert_true(_level_button(board, "ch_nurse", "none").button_pressed, "no mark means none")
	assert_eq(_note_edit(board, "ch_doctor").text, "Соврал про ключ")

	var timeline: Array[PanelContainer] = _cards(board, CaseBoard.Section.TIMELINE)
	assert_true(_has_text(timeline[0], "День 1, 08:00 — День 1, 20:40"), "sorted by time: earliest first")
	assert_true(_has_text(timeline[1], "День 2, 05:40"))
	assert_true(_has_text(timeline[0], "Источники: Дежурная медсестра:"))


func test_no_internal_ids_are_shown() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	for text: String in _texts(board):
		for fragment: String in ["clue_", "st_", "con_", "ch_", "loc_", "tl_", "topic_"]:
			assert_false(text.contains(fragment), "'%s' does not show an id" % text)


# --- filter -----------------------------------------------------------------------------------


func test_filter_lists_every_known_character_with_names() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	var filter: OptionButton = board.get_node(^"%Filter") as OptionButton

	assert_eq(board.get_characters(), ["ch_doctor", "ch_nurse"] as Array[String])
	assert_eq(filter.item_count, 3)
	assert_eq(filter.get_item_text(0), "Все персонажи")
	assert_eq(filter.get_item_text(1), "Доктор Белов")
	assert_eq(board.get_filter(), CaseBoard.ALL_CHARACTERS)


func test_filter_by_character_keeps_only_linked_entries() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	var filter: OptionButton = board.get_node(^"%Filter") as OptionButton

	filter.select(2)
	filter.item_selected.emit(2)

	assert_eq(board.get_filter(), "ch_nurse")
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 2, "the nurse's linked clues")
	assert_true(_has_text(_section(board, CaseBoard.Section.CLUES), "Следы сапог"))
	assert_eq(_cards(board, CaseBoard.Section.STATEMENTS).size(), 1, "only her statement")
	assert_eq(_cards(board, CaseBoard.Section.CONTRADICTIONS).size(), 0)
	assert_true(
		_has_text(_section(board, CaseBoard.Section.CONTRADICTIONS), "Ничего не связано с персонажем «Дежурная медсестра»")
	)
	assert_eq(_cards(board, CaseBoard.Section.PERSONS).size(), 1)
	assert_eq(_cards(board, CaseBoard.Section.TIMELINE).size(), 1, "the entry sourced by her statement")

	board.set_filter("ch_doctor")
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 1)
	assert_eq(_cards(board, CaseBoard.Section.CONTRADICTIONS).size(), 1)
	assert_eq(_cards(board, CaseBoard.Section.TIMELINE).size(), 1)

	board.set_filter(CaseBoard.ALL_CHARACTERS)
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 5)
	assert_eq(filter.selected, 0)


func test_filter_set_before_ready_applies_to_the_first_view() -> void:
	_store.set_view(_fixture("mid"), 1)
	var board: CaseBoard = CaseBoardScene.instantiate() as CaseBoard
	board.set_params({})
	board.bind_store(_store)
	board.set_filter("ch_nurse")
	add_child_autofree(board)

	assert_eq(board.get_filter(), "ch_nurse")
	assert_eq(_cards(board, CaseBoard.Section.STATEMENTS).size(), 1)


func test_unknown_filter_resets_to_everyone() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	board.set_filter("ch_nobody")

	assert_eq(board.get_filter(), CaseBoard.ALL_CHARACTERS)
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 5)


func test_filter_survives_a_view_update_while_the_character_is_known() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	board.set_filter("ch_doctor")

	_store.set_view(_fixture("mid"), 2)
	assert_eq(board.get_filter(), "ch_doctor")
	assert_eq((board.get_node(^"%Filter") as OptionButton).selected, 1)

	_store.set_view(_fixture("start"), 3)
	assert_eq(board.get_filter(), CaseBoard.ALL_CHARACTERS, "a character the view no longer names")


# --- markSuspicion ----------------------------------------------------------------------------


func test_level_button_sends_mark_suspicion_with_the_protocol_level() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	_backend.change_state(BackendScript.ConnectionState.ONLINE)

	_level_button(board, "ch_doctor", "prime").pressed.emit()

	assert_eq(_backend.sent.size(), 1)
	assert_eq(
		_backend.sent[0],
		{"type": ProtocolConstants.ACTION_MARK_SUSPICION, "characterId": "ch_doctor", "level": 2}
	)
	assert_true(board.is_awaiting_result())
	assert_true(_level_button(board, "ch_nurse", "possible").disabled, "controls lock while in flight")
	assert_false(
		_level_button(board, "ch_doctor", "prime").button_pressed,
		"the board shows the confirmed mark, not the click"
	)


func test_each_level_maps_to_its_index() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	var expected: Dictionary = {"none": 0, "possible": 1, "prime": 2}
	for level: String in expected:
		_backend.sent.clear()
		assert_eq(board.mark_suspicion("ch_nurse", level), OK)
		var sent_level: int = _backend.sent[0]["level"]
		var expected_level: int = expected[level]
		assert_eq(sent_level, expected_level)
		_store.set_view(_fixture("mid"), _store.get_state_version() + 1)


func test_pressing_the_current_level_sends_nothing() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	_level_button(board, "ch_doctor", "possible").pressed.emit()

	assert_eq(_backend.sent.size(), 0)
	assert_false(board.is_awaiting_result())


func test_note_submit_sends_the_current_level_and_the_note() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	var note: LineEdit = _note_edit(board, "ch_doctor")

	note.text_submitted.emit("  Был у процедурной  ")

	assert_eq(
		_backend.sent[0],
		{
			"type": ProtocolConstants.ACTION_MARK_SUSPICION,
			"characterId": "ch_doctor",
			"level": 1,
			"note": "Был у процедурной",
		}
	)


func test_unchanged_note_sends_nothing() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	_note_edit(board, "ch_doctor").text_submitted.emit("Соврал про ключ")

	assert_eq(_backend.sent.size(), 0)


func test_second_mark_waits_for_the_first_result() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	assert_eq(board.mark_suspicion("ch_nurse", "possible"), OK)
	assert_eq(board.mark_suspicion("ch_doctor", "prime"), ERR_BUSY)
	assert_eq(_backend.sent.size(), 1)


func test_invalid_level_is_refused_locally() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	assert_eq(board.mark_suspicion("ch_nurse", "certain"), ERR_INVALID_PARAMETER)
	assert_eq(board.mark_suspicion("", "prime"), ERR_INVALID_PARAMETER)
	assert_eq(_backend.sent.size(), 0)


func test_server_refusal_unlocks_and_shows_the_error() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	board.mark_suspicion("ch_nurse", "prime")

	_backend.deliver(
		ProtocolConstants.MSG_ACTION_RESULT,
		{"requestId": "r-1", "ok": false, "error": ProtocolConstants.ERROR_ACTION_NOT_AVAILABLE}
	)

	assert_false(board.is_awaiting_result())
	assert_eq(_label(board, "Error").text, "Это действие сейчас недоступно.")
	assert_false(_level_button(board, "ch_nurse", "prime").disabled)


func test_send_failure_without_connection_is_reported() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	_backend.send_result = ERR_CONNECTION_ERROR

	board.mark_suspicion("ch_nurse", "prime")

	assert_false(board.is_awaiting_result())
	assert_string_contains(_label(board, "Error").text, "Нет соединения с сервером.")


func test_failures_of_other_screens_are_not_shown() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))

	_store.action_failed.emit(ProtocolConstants.ERROR_ACTION_BLOCKED, "")

	assert_eq(_label(board, "Error").text, "")


# --- view updates -----------------------------------------------------------------------------


func test_new_view_shows_the_confirmed_mark_and_unlocks() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	board.mark_suspicion("ch_nurse", "prime")
	var marked: Dictionary = _with_board(
		_fixture("mid"),
		{
			"suspicions": [
				{"characterId": "ch_doctor", "level": "possible", "note": "Соврал про ключ"},
				{"characterId": "ch_nurse", "level": "prime"},
			],
		}
	)

	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 2, "view": marked})

	assert_false(board.is_awaiting_result())
	assert_true(_level_button(board, "ch_nurse", "prime").button_pressed)
	assert_false(_level_button(board, "ch_nurse", "prime").disabled)


func test_board_follows_new_views_and_counts() -> void:
	var board: CaseBoard = _live_board(_fixture("start"))
	assert_eq(_tabs(board).get_tab_title(CaseBoard.Section.CLUES), "Улики (0)")

	_store.set_view(_fixture("mid"), 2)

	assert_eq(_tabs(board).get_tab_title(CaseBoard.Section.CLUES), "Улики (5)")
	assert_false(board.is_preview())


func test_live_view_replaces_the_standalone_preview() -> void:
	var board: CaseBoard = CaseBoardScene.instantiate() as CaseBoard
	board.bind_store(_store)
	add_child_autofree(board)
	assert_true(board.is_preview())

	_store.set_view(_fixture("start"), 1)

	assert_false(board.is_preview())
	assert_eq(_label(board, "Status").text, "")


func test_names_seen_earlier_stay_while_the_board_is_open() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	var later: Dictionary = _with_board(_fixture("mid"), {"personsOfInterest": []})

	_store.set_view(later, 2)

	assert_true(_has_text(_section(board, CaseBoard.Section.STATEMENTS), "Дежурная медсестра"))
	assert_false(_has_text(_section(board, CaseBoard.Section.PERSONS), "персона интереса"))


func test_session_end_clears_the_board() -> void:
	var board: CaseBoard = _live_board(_fixture("mid"))
	_backend.change_state(BackendScript.ConnectionState.ONLINE)

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)

	assert_false(_tabs(board).visible)
	assert_eq(_label(board, "Status").text, CaseBoard.NO_VIEW_TEXT)
	assert_eq(board.character_name("ch_doctor"), CaseBoard.UNKNOWN_CHARACTER_TEXT)


# --- empty and partial data -------------------------------------------------------------------


func test_routed_board_without_a_view_waits_for_the_server() -> void:
	var board: CaseBoard = _board({"back": "exploration"})

	assert_false(board.is_preview())
	assert_false(_tabs(board).visible)
	assert_eq(_label(board, "Status").text, CaseBoard.NO_VIEW_TEXT)
	assert_true((board.get_node(^"%Filter") as OptionButton).disabled)


func test_empty_case_board_shows_a_placeholder_per_section() -> void:
	var view: Dictionary = _fixture("start").duplicate(true)
	view["presentCharacters"] = []
	var board: CaseBoard = _live_board(view)

	assert_true(_tabs(board).visible)
	for section: int in CaseBoard.SECTION_EMPTY.size():
		var container: VBoxContainer = _section(board, section as CaseBoard.Section)
		assert_eq(container.get_child_count(), 1)
		assert_true(_has_text(container, CaseBoard.SECTION_EMPTY[section]))
	assert_eq(board.get_characters().size(), 0)
	assert_true((board.get_node(^"%Filter") as OptionButton).disabled, "nobody to filter by")


func test_characters_present_can_be_marked_before_any_clue() -> void:
	var board: CaseBoard = _live_board(_fixture("start"))

	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 0)
	assert_eq(
		board.get_characters(), ["ch_nurse", "ch_guest_1"] as Array[String], "the characters present"
	)
	assert_eq(_cards(board, CaseBoard.Section.PERSONS).size(), 2)
	assert_false(_has_text(_section(board, CaseBoard.Section.PERSONS), "персона интереса"))
	assert_eq(board.mark_suspicion("ch_guest_1", "possible"), OK)
	var sent_id: String = str(_backend.sent[0]["characterId"])
	assert_eq(sent_id, "ch_guest_1")


func test_view_without_case_board_or_clock_still_renders() -> void:
	var view: Dictionary = _fixture("mid").duplicate(true)
	view.erase("caseBoard")
	view.erase("clock")
	var board: CaseBoard = _board()
	board.call(&"_show", view)

	assert_true(_tabs(board).visible)
	assert_true(_has_text(_section(board, CaseBoard.Section.CLUES), CaseBoard.SECTION_EMPTY[0]))
	assert_eq(board.get_characters(), ["ch_doctor"] as Array[String], "the present character")


func test_missing_optional_fields_fall_back_honestly() -> void:
	var view: Dictionary = _with_board(
		_fixture("mid"),
		{
			"clues": [{"id": "clue_x", "kind": "strange", "discoveredAt": 30.0, "locationId": "loc_unknown"}],
			"statements": [{"id": "st_x", "characterId": "ch_stranger", "text": "Я ничего не видел."}],
			"contradictions": [{"id": "con_x", "statementId": "st_missing", "againstId": "clue_missing", "summary": "Не сходится."}],
			"personsOfInterest": [{"characterId": "ch_ghost", "name": "", "linkedClueIds": ["clue_missing"]}],
			"suspicions": [{"characterId": "ch_widow", "level": "unknown"}],
			"timeline": [{"id": "tl_x", "text": "Без времени", "sourceIds": []}, {"id": "tl_y", "from": 10, "text": "Рано", "sourceIds": ["st_x"]}],
		}
	)
	var board: CaseBoard = _board()
	board.call(&"_show", view)

	var clues: VBoxContainer = _section(board, CaseBoard.Section.CLUES)
	assert_true(_has_text(clues, "Без названия"))
	assert_true(_has_text(clues, "Улика · День 1, 08:30"), "unknown kind and float minute")
	assert_false(_has_text(clues, "сохранена"), "absent captured flag is not guessed")
	assert_true(_has_text(_section(board, CaseBoard.Section.STATEMENTS), "время неизвестно"))
	assert_true(_has_text(_section(board, CaseBoard.Section.STATEMENTS), CaseBoard.UNKNOWN_CHARACTER_TEXT))
	assert_true(_has_text(_section(board, CaseBoard.Section.CONTRADICTIONS), "Не сходится."))
	assert_false(_has_text(_section(board, CaseBoard.Section.CONTRADICTIONS), "Опровергает"))
	assert_true(_has_text(_section(board, CaseBoard.Section.PERSONS), "связанных улик: 1"))
	assert_true(_level_button(board, "ch_widow", "none").button_pressed, "unknown level shows as none")
	var timeline: Array[PanelContainer] = _cards(board, CaseBoard.Section.TIMELINE)
	assert_true(_has_text(timeline[0], "Рано"), "timed entries first")
	assert_true(_has_text(timeline[1], "время неизвестно"))


func test_view_with_server_only_data_is_not_shown() -> void:
	var leaked: Dictionary = _with_board(
		_fixture("mid"), {"statements": [{"id": "st_x", "characterId": "ch_doctor", "text": "…", "heardAt": 5, "veracity": "lie"}]}
	)
	var board: CaseBoard = _board()

	board.call(&"_show", leaked)

	assert_push_error("server-only field 'veracity'")
	assert_false(_tabs(board).visible)
	assert_true(board.get_view().is_empty())


# --- 20+ clues ----------------------------------------------------------------------------------


func test_large_fixture_renders_every_entry() -> void:
	var view: Dictionary = CaseBoardFixtures.large_view(24)
	var board: CaseBoard = _live_board(view)
	var case_board: Dictionary = view["caseBoard"]

	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 24)
	assert_eq(_cards(board, CaseBoard.Section.STATEMENTS).size(), (case_board["statements"] as Array).size())
	assert_eq(_cards(board, CaseBoard.Section.CONTRADICTIONS).size(), 6)
	assert_eq(_cards(board, CaseBoard.Section.TIMELINE).size(), 12)
	assert_eq(board.get_characters().size(), 8, "POIs, the marked widow and the present janitor")
	assert_true(_level_button(board, "ch_doctor", "prime").button_pressed)

	board.set_filter("ch_doctor")
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 4)
	assert_eq(_cards(board, CaseBoard.Section.STATEMENTS).size(), 2)


func test_large_fixture_update_cost() -> void:
	# Headless timing of the work a view update causes with 24 clues: a changed case board rebuilds
	# the open tab, an unchanged one (the clock moved) rebuilds nothing. The FPS itself is measured
	# in a window with tests/perf/case_board_fps.tscn (godot-client.md §4.2).
	var board: CaseBoard = _live_board(CaseBoardFixtures.large_view(24))
	var views: Array[Dictionary] = [CaseBoardFixtures.large_view(25), CaseBoardFixtures.large_view(24)]
	var started: int = Time.get_ticks_usec()
	for version: int in range(2, 22):
		_store.set_view(views[version % 2], version)
	var changed_ms: float = float(Time.get_ticks_usec() - started) / 20.0 / 1000.0

	var clock_only: Dictionary = CaseBoardFixtures.large_view(24).duplicate(true)
	started = Time.get_ticks_usec()
	for version: int in range(22, 42):
		(clock_only["clock"] as Dictionary)["remainingMinutes"] = 2000 - version
		_store.set_view(clock_only, version)
	var unchanged_ms: float = float(Time.get_ticks_usec() - started) / 20.0 / 1000.0

	started = Time.get_ticks_usec()
	for section: int in CaseBoard.SECTION_TITLES.size():
		board.get_section(section as CaseBoard.Section)
	var all_tabs_ms: float = float(Time.get_ticks_usec() - started) / 1000.0

	gut.p("24 clues: changed board %.2f ms, unchanged board %.2f ms, building every tab %.2f ms" % [changed_ms, unchanged_ms, all_tabs_ms])
	assert_lt(unchanged_ms, 4.0, "an update that does not touch the case board rebuilds nothing")
	assert_lt(changed_ms, 16.0, "a changed case board stays within one 60 FPS frame (budgeted build)")
	assert_eq(_cards(board, CaseBoard.Section.CLUES).size(), 24)


func test_long_board_completes_over_frames_without_being_asked() -> void:
	var board: CaseBoard = _live_board(CaseBoardFixtures.large_view(100))
	var clues: VBoxContainer = board.get_node(^"%Clues") as VBoxContainer
	var first_frame: int = clues.get_child_count()
	assert_gt(first_frame, 0, "the open tab starts showing at once")

	for _frame: int in 120:
		if clues.get_child_count() >= 100:
			break
		await get_tree().process_frame

	assert_eq(clues.get_child_count(), 100, "the rest of the cards arrive in the following frames")
	assert_false(board.is_processing(), "the board stops working once the tab is complete")
	gut.p("100 clues: %d cards in the first frame" % first_frame)
