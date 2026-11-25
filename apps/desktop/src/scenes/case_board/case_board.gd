extends Control
## Case board (godot-client.md §4.2, investigation-model.md §7): the clues, statements,
## contradictions, persons of interest with the player's suspicion marks, and the timeline.
##
## Everything shown is the `caseBoard` of the PlayerView in GameStore, plus names the same view
## carries. The board computes no game rules (ADR 0002): it does not find contradictions, pick
## persons of interest or judge anyone; it only lays out, sorts the timeline by time and filters by
## a character using links the view already holds. A suspicion mark goes out as the `markSuspicion`
## action through [method GameStoreScript.request_action]; the board shows the new mark only when
## the server sends a view with it.
##
## A SceneRouter screen (`case_board`) and a reusable scene: instance `case_board.tscn` anywhere and
## it follows the GameStore autoload (or the store passed to [method bind_store]). Route params:
## `{"back": "<screen>"}` shows a back button, `{"preview": "start|mid|capture|end|large"}` renders a
## fixture without a session server (as the scene does when run on its own).
## "Обвинить…" opens the `accusation` screen (GDT-009) with a way back to this board; it is hidden
## without a view and once the game is over.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const CaseBoardFormat = preload("res://src/scenes/case_board/case_board_format.gd")
const CaseBoardFixtures = preload("res://src/scenes/case_board/case_board_fixtures.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

## Emitted when the player presses the back button (shown with the `back` route param).
signal close_requested

enum Section { CLUES, STATEMENTS, CONTRADICTIONS, PERSONS, TIMELINE }

const PARAM_PREVIEW: String = "preview"
const PARAM_BACK: String = "back"
const PREVIEW_LARGE: String = "large"
const PREVIEW_DEFAULT: String = "mid"
## Filter value that shows every character.
const ALL_CHARACTERS: String = ""
## Metadata of suspicion controls: the character and the level a button sets.
const META_CHARACTER: StringName = &"character_id"
const META_LEVEL: StringName = &"suspicion_level"
## Real time per frame the board spends building cards (a UI budget, not game time): a long case
## board appears over a few frames instead of stalling one (FPS check: tests/perf/case_board_fps).
const BUILD_BUDGET_USEC: int = 6000

const SECTION_TITLES: Array[String] = [
	"Улики", "Показания", "Противоречия", "Персоны интереса", "Хронология"
]
const SECTION_EMPTY: Array[String] = [
	"Улик пока нет.",
	"Показаний пока нет.",
	"Противоречий пока не найдено.",
	"Персон интереса пока нет.",
	"Хронология пуста.",
]
const SECTION_EMPTY_FILTERED: String = "Ничего не связано с персонажем «%s»."
const ALL_CHARACTERS_TEXT: String = "Все персонажи"
const NO_VIEW_TEXT: String = "Нет данных дела: ожидание состояния от сервера."
const PREVIEW_TEXT: String = "Предпросмотр без сервера: фикстура %s"
const PREVIEW_FAILED_TEXT: String = "Предпросмотр недоступен: фикстура «%s» не загружена."
const UNKNOWN_CHARACTER_TEXT: String = "Неизвестный персонаж"
const UNTITLED_TEXT: String = "Без названия"
const CAPTURED_TEXT: String = "сохранена на телефоне"
const NOT_CAPTURED_TEXT: String = "не сохранена на телефоне"
const POI_TEXT: String = "персона интереса"
const LINKED_TEXT: String = "Связанные улики: %s"
const LINKED_UNKNOWN_TEXT: String = "связанных улик: %d"
const SUSPICION_TEXT: String = "Подозрение:"
const NOTE_PLACEHOLDER: String = "Заметка (Enter — сохранить)"
const STATEMENT_TEXT: String = "Показание"
const AGAINST_TEXT: String = "Опровергает"
const SOURCES_TEXT: String = "Источники: %s"
const ERROR_TEXT: Dictionary = {
	ProtocolConstants.ERROR_ACTION_INVALID: "Сервер отклонил действие.",
	ProtocolConstants.ERROR_ACTION_NOT_AVAILABLE: "Это действие сейчас недоступно.",
	ProtocolConstants.ERROR_ACTION_BLOCKED: "Действие заблокировано.",
	ProtocolConstants.ERROR_GAME_OVER: "Игра окончена.",
	ProtocolConstants.ERROR_RATE_LIMITED: "Слишком много запросов, попробуйте позже.",
	GameStoreScript.ERROR_NOT_CONNECTED: "Нет соединения с сервером.",
}
const ERROR_FALLBACK_TEXT: String = "Не удалось выполнить действие (%s)."

var _store: GameStoreScript = null
var _params: Dictionary = ReadOnly.empty()
var _params_received: bool = false
var _preview_name: String = ""
var _preview_failed: bool = false
var _view: Dictionary = ReadOnly.empty()
var _filter: String = ALL_CHARACTERS
var _pending: bool = false
# Names of characters and locations seen in the views this board received while it is open:
# a statement or a mark may name a character who is not in the current view's lists.
var _names: Dictionary = {}
var _location_names: Dictionary = {}
var _characters: Array[String] = []
var _suspicion_controls: Array[Control] = []
var _card_style: StyleBoxFlat = _make_card_style()
# What the last render selected per section, and whether a section's cards are built.
var _signature: Array = []
var _entries: Array[Array] = [[], [], [], [], []]
var _built: Array[bool] = [false, false, false, false, false]
var _next: Array[int] = [0, 0, 0, 0, 0]
var _clue_by_id: Dictionary = {}
var _statement_by_id: Dictionary = {}
var _person_by_id: Dictionary = {}
var _suspicion_by_id: Dictionary = {}
var _origin: Variant = null

@onready var _status: Label = %Status
@onready var _error: Label = %Error
@onready var _back: Button = %Back
@onready var _accuse: Button = %Accuse
@onready var _filter_option: OptionButton = %Filter
@onready var _tabs: TabContainer = %Tabs
@onready var _sections: Array[VBoxContainer] = [%Clues, %Statements, %Contradictions, %Persons, %Timeline]


## Called by SceneRouter before _ready. A board that never gets params was run on its own.
func set_params(params: Dictionary) -> void:
	_params = params
	_params_received = true


## Listens to [param store] instead of the GameStore autoload (tests pass their own store).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.action_failed.disconnect(_on_action_failed)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.action_failed.connect(_on_action_failed)
		_store.connection_state_changed.connect(_on_connection_state_changed)
	if is_node_ready():
		_refresh()


func _ready() -> void:
	_back.visible = not _text(_params.get(PARAM_BACK)).is_empty()
	_back.pressed.connect(_on_back_pressed)
	_accuse.pressed.connect(open_accusation)
	_filter_option.item_selected.connect(_on_filter_selected)
	_tabs.tab_changed.connect(_on_tab_changed)
	set_process(false)
	for section: int in _sections.size():
		_tabs.set_tab_title(section, SECTION_TITLES[section])
	if _store == null:
		var autoload: Node = get_node_or_null(^"/root/GameStore")
		if autoload is GameStoreScript:
			bind_store(autoload as GameStoreScript)
			return
	_refresh()


## The view on screen (read-only): the live view, a preview fixture or an empty Dictionary.
func get_view() -> Dictionary:
	return _view


func is_preview() -> bool:
	return not _preview_name.is_empty()


## True while a `markSuspicion` was sent and neither a new view nor a failure has arrived.
func is_awaiting_result() -> bool:
	return _pending


## The character the board is filtered by; [constant ALL_CHARACTERS] for none.
func get_filter() -> String:
	return _filter


## Characters the filter offers, in the order of the view: persons of interest, marked characters,
## statement speakers, characters present, the conversation partner.
func get_characters() -> Array[String]:
	return _characters.duplicate()


## Shows only what the view links to [param character_id] ([constant ALL_CHARACTERS] — everything).
## An id the board does not know resets the filter.
func set_filter(character_id: String) -> void:
	if not is_node_ready():
		# Checked against the known characters once the first view is shown.
		_filter = character_id
		return
	_filter = character_id if _characters.has(character_id) else ALL_CHARACTERS
	_select_filter_item()
	_render()


## The name the board shows for [param character_id].
func character_name(character_id: String) -> String:
	return str(_names.get(character_id, UNKNOWN_CHARACTER_TEXT))


## Container with the entries of [param section] (one child per entry or one placeholder label).
## A section is built when its tab is first shown; asking for it builds it.
func get_section(section: Section) -> VBoxContainer:
	_build_section(section)
	return _sections[section]


## Sends `markSuspicion` for [param character_id]; [param note] null keeps the current note, an
## empty string removes it. Returns the result of [method GameStoreScript.request_action] or an
## error when the level is unknown, an action is in flight or there is no store.
func mark_suspicion(character_id: String, level: String, note: Variant = null) -> Error:
	var code: int = CaseBoardFormat.level_code(level)
	if code < 0 or character_id.is_empty():
		return ERR_INVALID_PARAMETER
	if _pending:
		return ERR_BUSY
	_error.text = ""
	if _store == null:
		_show_error(GameStoreScript.ERROR_NOT_CONNECTED, "")
		return ERR_UNCONFIGURED
	var action: Dictionary = {
		"type": ProtocolConstants.ACTION_MARK_SUSPICION,
		"characterId": character_id,
		"level": code,
	}
	if note is String:
		action["note"] = note
	_pending = true
	_update_controls()
	# A refusal comes back as action_failed (even synchronously); a success as view_changed.
	return _store.request_action(action)


## Opens the `accusation` screen; its back button returns to this board with the same params.
func open_accusation() -> Error:
	var router: Node = get_node_or_null(^"/root/SceneRouter")
	if not router is SceneRouterScript:
		return ERR_UNCONFIGURED
	var params: Dictionary = {"back": "case_board", "backParams": _params.duplicate(true)}
	if is_preview():
		# The accusation previews PlayerView fixtures only (no "large" board fixture).
		var known: bool = PreviewFixtures.NAMES.has(_preview_name)
		params[PARAM_PREVIEW] = _preview_name if known else PreviewFixtures.DEFAULT_NAME
	return (router as SceneRouterScript).goto(&"accusation", params)


## Picks what to show: an explicit preview, the store's view, the standalone preview or nothing.
func _refresh() -> void:
	var requested: String = _text(_params.get(PARAM_PREVIEW))
	var has_live_view: bool = _store != null and _store.has_view()
	if requested.is_empty() and not _params_received and not has_live_view:
		requested = PREVIEW_DEFAULT
	if not requested.is_empty() and (_params.has(PARAM_PREVIEW) or not has_live_view):
		var fixture: Dictionary = _load_preview(requested)
		_preview_name = requested
		_preview_failed = fixture.is_empty()
		_show(fixture)
		return
	_preview_name = ""
	_preview_failed = false
	_show(_store.get_view() if has_live_view else ReadOnly.empty())


static func _load_preview(fixture_name: String) -> Dictionary:
	if fixture_name == PREVIEW_LARGE:
		return CaseBoardFixtures.large_view()
	return PreviewFixtures.load_view(fixture_name)


func _show(view: Dictionary) -> void:
	var leaked: String = GameStoreScript.find_forbidden_key(view)
	if not leaked.is_empty():
		push_error("CaseBoard: view with the server-only field '%s' is not shown" % leaked)
		view = ReadOnly.empty()
	_view = view
	_accuse.visible = not view.is_empty() and not view.has("ending")
	_learn_names(view)
	_characters = _known_characters(view)
	if not _characters.has(_filter):
		_filter = ALL_CHARACTERS
	_rebuild_filter()
	# Most views change the clock or the location, not the case board: then nothing is rebuilt.
	var signature: Array = [
		_view.is_empty(),
		_view.get("caseBoard"),
		CaseBoardFormat.clock_origin(_dict(_view.get("clock"))),
		_characters,
		_names,
		_location_names,
	]
	if signature == _signature:
		_render_status()
		_update_controls()
		return
	_signature = signature.duplicate(true)
	_render()


func _render_status() -> void:
	if _view.is_empty():
		_status.text = (PREVIEW_FAILED_TEXT % _preview_name) if _preview_failed else NO_VIEW_TEXT
	else:
		_status.text = (PREVIEW_TEXT % _preview_name) if is_preview() else ""


## Selects what each section shows and builds the open tab; the others are built when opened
## ([method _build_section]), so a view update costs one tab of cards, not five.
func _render() -> void:
	_suspicion_controls.clear()
	_render_status()
	for section: int in _sections.size():
		_clear(_sections[section])
		_built[section] = false
		_next[section] = 0
		_entries[section] = []
	if _view.is_empty():
		set_process(false)
		_tabs.visible = false
		_filter_option.disabled = true
		return
	_tabs.visible = true
	_filter_option.disabled = _characters.is_empty()

	var board: Dictionary = _dict(_view.get("caseBoard"))
	var clues: Array[Dictionary] = _dicts(board.get("clues"))
	var statements: Array[Dictionary] = _dicts(board.get("statements"))
	var persons: Array[Dictionary] = _dicts(board.get("personsOfInterest"))
	_clue_by_id = _index(clues, "id")
	_statement_by_id = _index(statements, "id")
	_person_by_id = _index(persons, "characterId")
	_suspicion_by_id = _index(_dicts(board.get("suspicions")), "characterId")
	_origin = CaseBoardFormat.clock_origin(_dict(_view.get("clock")))

	# Links the view itself holds: a person of interest's clues and a speaker's statements.
	var related: Dictionary = {}
	if _filter != ALL_CHARACTERS:
		var person: Dictionary = _dict(_person_by_id.get(_filter))
		for clue_id: String in _strings(person.get("linkedClueIds")):
			related[clue_id] = true
		for statement: Dictionary in statements:
			if _text(statement.get("characterId")) == _filter:
				related[_text(statement.get("id"))] = true

	for clue: Dictionary in clues:
		if _shown(related, [_text(clue.get("id"))]):
			_entries[Section.CLUES].append(clue)
	for statement: Dictionary in statements:
		if _shown(related, [_text(statement.get("id"))]):
			_entries[Section.STATEMENTS].append(statement)
	for contradiction: Dictionary in _dicts(board.get("contradictions")):
		var ends: Array[String] = [
			_text(contradiction.get("statementId")), _text(contradiction.get("againstId"))
		]
		if _shown(related, ends):
			_entries[Section.CONTRADICTIONS].append(contradiction)
	for character_id: String in _characters:
		if _filter == ALL_CHARACTERS or _filter == character_id:
			_entries[Section.PERSONS].append(character_id)
	for entry: Dictionary in _sorted_timeline(_dicts(board.get("timeline"))):
		if _shown(related, _strings(entry.get("sourceIds"))):
			_entries[Section.TIMELINE].append(entry)

	for section: int in _sections.size():
		var title: String = "%s (%d)" % [SECTION_TITLES[section], _entries[section].size()]
		_tabs.set_tab_title(section, title)
	_build_open_tab()


## Builds the cards of [param section] that are not built yet. With [param budget_usec] > 0 it
## stops once that much real time is spent (at least one card is built) and returns false if cards
## remain; 0 builds them all. A UI frame budget only: game time is not involved.
func _build_section(section: int, budget_usec: int = 0) -> bool:
	if section < 0 or section >= _sections.size() or _built[section] or _view.is_empty():
		return true
	var started: int = Time.get_ticks_usec()
	var container: VBoxContainer = _sections[section]
	var entries: Array = _entries[section]
	while _next[section] < entries.size():
		if budget_usec > 0 and _next[section] > 0 and Time.get_ticks_usec() - started >= budget_usec:
			_update_controls()
			return false
		container.add_child(_make_card(section, entries[_next[section]]))
		_next[section] += 1
	_built[section] = true
	if entries.is_empty():
		var empty: String = SECTION_EMPTY[section]
		if _filter != ALL_CHARACTERS:
			empty = SECTION_EMPTY_FILTERED % character_name(_filter)
		_add_placeholder(container, empty)
	_update_controls()
	return true


func _make_card(section: int, entry: Variant) -> Control:
	match section:
		Section.CLUES:
			return _clue_card(entry as Dictionary, _origin)
		Section.STATEMENTS:
			return _statement_card(entry as Dictionary, _origin)
		Section.CONTRADICTIONS:
			return _contradiction_card(entry as Dictionary, _statement_by_id, _clue_by_id)
		Section.PERSONS:
			var character_id: String = str(entry)
			return _person_card(
				character_id,
				_dict(_person_by_id.get(character_id)),
				_dict(_suspicion_by_id.get(character_id)),
				_clue_by_id
			)
	return _timeline_card(entry as Dictionary, _origin, _clue_by_id, _statement_by_id)


## Builds the open tab a frame budget at a time, so a long case board never stalls a frame.
func _build_open_tab() -> void:
	set_process(not _build_section(_tabs.current_tab, BUILD_BUDGET_USEC))


func _process(_delta: float) -> void:
	_build_open_tab()


func _on_tab_changed(_tab: int) -> void:
	_build_open_tab()


func _shown(related: Dictionary, ids: Array[String]) -> bool:
	if _filter == ALL_CHARACTERS:
		return true
	for value: String in ids:
		if related.has(value):
			return true
	return false


# --- cards ------------------------------------------------------------------------------------


func _clue_card(clue: Dictionary, origin: Variant) -> Control:
	var body: VBoxContainer = _card()
	_add_label(body, _or(_text(clue.get("title")), UNTITLED_TEXT), 20)
	var meta: PackedStringArray = PackedStringArray([CaseBoardFormat.kind_text(clue.get("kind"))])
	meta.append(CaseBoardFormat.minute_text(clue.get("discoveredAt"), origin))
	var place: String = str(_location_names.get(_text(clue.get("locationId")), ""))
	if not place.is_empty():
		meta.append(place)
	var captured: Variant = clue.get("captured")
	if captured is bool:
		meta.append(CAPTURED_TEXT if captured else NOT_CAPTURED_TEXT)
	_add_label(body, " · ".join(meta), 0, 0.7)
	_add_label(body, _text(clue.get("description")))
	return body.get_parent() as Control


func _statement_card(statement: Dictionary, origin: Variant) -> Control:
	var body: VBoxContainer = _card()
	_add_label(body, character_name(_text(statement.get("characterId"))), 20)
	_add_label(body, CaseBoardFormat.minute_text(statement.get("heardAt"), origin), 0, 0.7)
	_add_label(body, "«%s»" % _text(statement.get("text")))
	return body.get_parent() as Control


func _contradiction_card(
	contradiction: Dictionary, statement_by_id: Dictionary, clue_by_id: Dictionary
) -> Control:
	var body: VBoxContainer = _card()
	_add_label(body, _or(_text(contradiction.get("summary")), UNTITLED_TEXT), 20)
	var statement_id: String = _text(contradiction.get("statementId"))
	if statement_by_id.has(statement_id):
		_add_label(body, "%s: %s" % [STATEMENT_TEXT, _source_text(statement_id, clue_by_id, statement_by_id)], 0, 0.8)
	var against_id: String = _text(contradiction.get("againstId"))
	if clue_by_id.has(against_id) or statement_by_id.has(against_id):
		_add_label(body, "%s: %s" % [AGAINST_TEXT, _source_text(against_id, clue_by_id, statement_by_id)], 0, 0.8)
	return body.get_parent() as Control


func _person_card(
	character_id: String, person: Dictionary, suspicion: Dictionary, clue_by_id: Dictionary
) -> Control:
	var body: VBoxContainer = _card()
	var title: String = character_name(character_id)
	if not person.is_empty():
		title += " — " + POI_TEXT
	_add_label(body, title, 20)
	if not person.is_empty():
		var linked: Array[String] = _strings(person.get("linkedClueIds"))
		var titles: PackedStringArray = PackedStringArray()
		for clue_id: String in linked:
			if clue_by_id.has(clue_id):
				titles.append(_or(_text(_dict(clue_by_id[clue_id]).get("title")), UNTITLED_TEXT))
		if not titles.is_empty():
			_add_label(body, LINKED_TEXT % ", ".join(titles), 0, 0.8)
		elif not linked.is_empty():
			_add_label(body, LINKED_UNKNOWN_TEXT % linked.size(), 0, 0.8)

	var current: String = CaseBoardFormat.normalize_level(suspicion.get("level"))
	var row: HBoxContainer = HBoxContainer.new()
	var caption: Label = Label.new()
	caption.text = SUSPICION_TEXT
	row.add_child(caption)
	for level: String in CaseBoardFormat.SUSPICION_LEVELS:
		var button: Button = Button.new()
		button.text = CaseBoardFormat.level_text(level)
		button.toggle_mode = true
		button.button_pressed = level == current
		button.set_meta(META_CHARACTER, character_id)
		button.set_meta(META_LEVEL, level)
		button.pressed.connect(_on_level_pressed.bind(character_id, level, button))
		row.add_child(button)
		_suspicion_controls.append(button)
	body.add_child(row)

	var note: LineEdit = LineEdit.new()
	note.placeholder_text = NOTE_PLACEHOLDER
	note.text = _text(suspicion.get("note"))
	note.set_meta(META_CHARACTER, character_id)
	note.set_meta(META_LEVEL, current)
	note.text_submitted.connect(_on_note_submitted.bind(character_id, current))
	body.add_child(note)
	_suspicion_controls.append(note)
	return body.get_parent() as Control


func _timeline_card(
	entry: Dictionary, origin: Variant, clue_by_id: Dictionary, statement_by_id: Dictionary
) -> Control:
	var body: VBoxContainer = _card()
	_add_label(body, CaseBoardFormat.interval_text(entry.get("from"), entry.get("to"), origin), 0, 0.7)
	_add_label(body, _text(entry.get("text")), 20)
	var sources: PackedStringArray = PackedStringArray()
	for source_id: String in _strings(entry.get("sourceIds")):
		if clue_by_id.has(source_id) or statement_by_id.has(source_id):
			sources.append(_source_text(source_id, clue_by_id, statement_by_id))
	if not sources.is_empty():
		_add_label(body, SOURCES_TEXT % "; ".join(sources), 0, 0.8)
	return body.get_parent() as Control


## A clue by its title or a statement by its speaker and text; ids are never shown.
func _source_text(source_id: String, clue_by_id: Dictionary, statement_by_id: Dictionary) -> String:
	if clue_by_id.has(source_id):
		return _or(_text(_dict(clue_by_id[source_id]).get("title")), UNTITLED_TEXT)
	var statement: Dictionary = _dict(statement_by_id.get(source_id))
	return "%s: «%s»" % [character_name(_text(statement.get("characterId"))), _text(statement.get("text"))]


# --- input ------------------------------------------------------------------------------------


func _on_level_pressed(character_id: String, level: String, button: Button) -> void:
	# The button shows the mark the server confirmed, not the click, until a new view arrives.
	var suspicion: Dictionary = _suspicion_of(character_id)
	var current: String = CaseBoardFormat.normalize_level(suspicion.get("level"))
	button.set_pressed_no_signal(level == current)
	if level == current or _pending:
		return
	mark_suspicion(character_id, level)


func _on_note_submitted(text: String, character_id: String, level: String) -> void:
	var note: String = text.strip_edges()
	if note == _text(_suspicion_of(character_id).get("note")) or _pending:
		return
	mark_suspicion(character_id, level, note)


func _on_filter_selected(index: int) -> void:
	set_filter(_text(_filter_option.get_item_metadata(index)))


func _on_back_pressed() -> void:
	close_requested.emit()
	var back: String = _text(_params.get(PARAM_BACK))
	var router: Node = get_node_or_null(^"/root/SceneRouter")
	if not back.is_empty() and router is SceneRouterScript:
		(router as SceneRouterScript).goto(StringName(back))


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	_pending = false
	_preview_name = ""
	_preview_failed = false
	_error.text = ""
	_show(view)


func _on_action_failed(code: String, message: String) -> void:
	if not _pending:
		return
	_pending = false
	_show_error(code, message)
	_update_controls()


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.ONLINE:
		return
	_pending = false
	if state == BackendScript.ConnectionState.OFFLINE and not is_preview():
		# The session is over: GameStore forgot the view, the names of that session go too.
		_names.clear()
		_location_names.clear()
		_show(ReadOnly.empty())
	else:
		_update_controls()


func _show_error(code: String, message: String) -> void:
	var text: String = str(ERROR_TEXT.get(code, ERROR_FALLBACK_TEXT % code))
	if not message.is_empty():
		text += " " + message
	_error.text = text


func _update_controls() -> void:
	for control: Control in _suspicion_controls:
		if not is_instance_valid(control):
			continue
		if control is Button:
			(control as Button).disabled = _pending
		elif control is LineEdit:
			(control as LineEdit).editable = not _pending


# --- data from the view -----------------------------------------------------------------------


func _suspicion_of(character_id: String) -> Dictionary:
	var board: Dictionary = _dict(_view.get("caseBoard"))
	return _dict(_index(_dicts(board.get("suspicions")), "characterId").get(character_id))


func _learn_names(view: Dictionary) -> void:
	var board: Dictionary = _dict(view.get("caseBoard"))
	for person: Dictionary in _dicts(board.get("personsOfInterest")):
		_remember(_names, _text(person.get("characterId")), _text(person.get("name")))
	for character: Dictionary in _dicts(view.get("presentCharacters")):
		_remember(_names, _text(character.get("id")), _text(character.get("name")))
	var interaction: Dictionary = _dict(view.get("interaction"))
	_remember(_names, _text(interaction.get("characterId")), _text(interaction.get("characterName")))
	var location: Dictionary = _dict(view.get("location"))
	_remember(_location_names, _text(location.get("id")), _text(location.get("name")))
	for exit: Dictionary in _dicts(location.get("exits")):
		_remember(_location_names, _text(exit.get("locationId")), _text(exit.get("name")))


static func _known_characters(view: Dictionary) -> Array[String]:
	var board: Dictionary = _dict(view.get("caseBoard"))
	var found: Array[String] = []
	for person: Dictionary in _dicts(board.get("personsOfInterest")):
		_append_unique(found, _text(person.get("characterId")))
	for suspicion: Dictionary in _dicts(board.get("suspicions")):
		_append_unique(found, _text(suspicion.get("characterId")))
	for statement: Dictionary in _dicts(board.get("statements")):
		_append_unique(found, _text(statement.get("characterId")))
	for character: Dictionary in _dicts(view.get("presentCharacters")):
		_append_unique(found, _text(character.get("id")))
	_append_unique(found, _text(_dict(view.get("interaction")).get("characterId")))
	return found


func _rebuild_filter() -> void:
	_filter_option.clear()
	_filter_option.add_item(ALL_CHARACTERS_TEXT)
	_filter_option.set_item_metadata(0, ALL_CHARACTERS)
	for character_id: String in _characters:
		_filter_option.add_item(character_name(character_id))
		_filter_option.set_item_metadata(_filter_option.item_count - 1, character_id)
	_select_filter_item()


func _select_filter_item() -> void:
	for index: int in _filter_option.item_count:
		if _filter_option.get_item_metadata(index) == _filter:
			_filter_option.select(index)
			return


## Timeline entries by `from`, then `to`; entries without a valid `from` keep their order at the end.
static func _sorted_timeline(entries: Array[Dictionary]) -> Array[Dictionary]:
	var timed: Array[Dictionary] = []
	var untimed: Array[Dictionary] = []
	for entry: Dictionary in entries:
		if CaseBoardFormat.whole_minute(entry.get("from")) == null:
			untimed.append(entry)
		else:
			timed.append(entry)
	timed.sort_custom(_timeline_before)
	timed.append_array(untimed)
	return timed


static func _timeline_before(left: Dictionary, right: Dictionary) -> bool:
	var left_from: int = CaseBoardFormat.whole_minute(left.get("from"))
	var right_from: int = CaseBoardFormat.whole_minute(right.get("from"))
	if left_from != right_from:
		return left_from < right_from
	var left_to: Variant = CaseBoardFormat.whole_minute(left.get("to"))
	var right_to: Variant = CaseBoardFormat.whole_minute(right.get("to"))
	var left_end: int = left_to if left_to is int else left_from
	var right_end: int = right_to if right_to is int else right_from
	return left_end < right_end


# --- widgets ----------------------------------------------------------------------------------


## A card: a panel with a VBoxContainer body; returns the body (its parent is the card).
func _card() -> VBoxContainer:
	var panel: PanelContainer = PanelContainer.new()
	panel.add_theme_stylebox_override(&"panel", _card_style)
	var body: VBoxContainer = VBoxContainer.new()
	body.add_theme_constant_override(&"separation", 4)
	panel.add_child(body)
	return body


static func _add_label(container: Container, text: String, font_size: int = 0, alpha: float = 1.0) -> void:
	if text.is_empty():
		return
	var label: Label = Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	if font_size > 0:
		label.add_theme_font_size_override(&"font_size", font_size)
	if alpha < 1.0:
		label.modulate.a = alpha
	container.add_child(label)


static func _make_card_style() -> StyleBoxFlat:
	var style: StyleBoxFlat = StyleBoxFlat.new()
	style.bg_color = Color(1.0, 1.0, 1.0, 0.05)
	style.border_color = Color(1.0, 1.0, 1.0, 0.12)
	style.set_border_width_all(1)
	style.set_corner_radius_all(4)
	style.set_content_margin_all(10)
	return style


static func _clear(container: Container) -> void:
	for child: Node in container.get_children():
		container.remove_child(child)
		child.queue_free()


static func _add_placeholder(container: Container, text: String) -> void:
	var label: Label = Label.new()
	label.text = text
	label.modulate.a = 0.6
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	container.add_child(label)


static func _remember(names: Dictionary, key: String, value: String) -> void:
	if not key.is_empty() and not value.is_empty():
		names[key] = value


static func _append_unique(items: Array[String], value: String) -> void:
	if not value.is_empty() and not items.has(value):
		items.append(value)


static func _index(items: Array[Dictionary], key: String) -> Dictionary:
	var result: Dictionary = {}
	for item: Dictionary in items:
		var value: String = _text(item.get(key))
		if not value.is_empty() and not result.has(value):
			result[value] = item
	return result


static func _dict(value: Variant) -> Dictionary:
	if value is Dictionary:
		var result: Dictionary = value
		return result
	return ReadOnly.empty()


static func _dicts(value: Variant) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if value is Array:
		var items: Array = value
		for item: Variant in items:
			if item is Dictionary:
				result.append(item as Dictionary)
	return result


static func _strings(value: Variant) -> Array[String]:
	var result: Array[String] = []
	if value is Array:
		var items: Array = value
		for item: Variant in items:
			if item is String and not (item as String).is_empty():
				result.append(item as String)
	return result


static func _text(value: Variant) -> String:
	if value is String:
		var text: String = value
		return text
	return ""


static func _or(text: String, fallback: String) -> String:
	return text if not text.is_empty() else fallback
