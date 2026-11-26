extends Control
## Ending screen (godot-client.md §4.5, game-design.md §5): which of the six endings the game
## reached, its text, what the accusation proved, the TruthRecap, the seed and run statistics.
##
## Everything shown is the `ending` of the PlayerView in GameStore, which the server adds only once
## the game is over (ENG-006), plus counts the same view carries. The TruthRecap is the one place
## the solution appears; the screen shows it only from that field and never asks for the truth.
## Without `ending` the screen says the game is not over and shows no recap.
##
## A SceneRouter screen (`ending`), opened by EndingWatcher when a view with `ending` arrives.
## Route params: `{"preview": "<endingId>"}` renders a fixture of that ending without a session
## server (as the scene does with "solved" when run on its own).

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const EndingFormat = preload("res://src/scenes/ending/ending_format.gd")
const EndingFixtures = preload("res://src/scenes/ending/ending_fixtures.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

const PARAM_PREVIEW: String = "preview"
const DEFAULT_PREVIEW: String = "solved"
const CASE_BOARD_SCREEN: StringName = &"case_board"

const NOT_OVER_TEXT: String = "Игра ещё не окончена: концовки нет."
const NO_VIEW_TEXT: String = "Нет данных: ожидание состояния от сервера."
const PREVIEW_TEXT: String = "Предпросмотр без сервера: концовка %s"
const PREVIEW_FAILED_TEXT: String = "Предпросмотр недоступен: концовка «%s» не загружена."
const PROVEN_TITLE: String = "Обвинение"
const RECAP_TITLE: String = "Что произошло на самом деле"
const TIMELINE_TITLE: String = "Хронология"
const RESPONSIBLE_TEXT: String = "Ответственны: %s"
const NO_RECAP_TEXT: String = "Разбор истины недоступен."
const STATS_TITLE: String = "Статистика"
const CASE_BOARD_TEXT: String = "Доска дела"

var _store: GameStoreScript = null
var _params: Dictionary = ReadOnly.empty()
var _params_received: bool = false
var _preview_name: String = ""
var _view: Dictionary = ReadOnly.empty()
var _recap_shown: bool = false

var _status: Label
var _kind: Label
var _title: Label
var _text: Label
var _proven: VBoxContainer
var _recap: VBoxContainer
var _stats: GridContainer
var _case_board: Button


## Called by SceneRouter before _ready. A screen that never gets params was run on its own.
func set_params(params: Dictionary) -> void:
	_params = params
	_params_received = true


## Listens to [param store] instead of the GameStore autoload (tests pass their own store).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.connection_state_changed.connect(_on_connection_state_changed)
	if is_node_ready():
		_refresh()


func _ready() -> void:
	_build_ui()
	if _store == null:
		var autoload: Node = get_node_or_null(^"/root/GameStore")
		if autoload is GameStoreScript:
			bind_store(autoload as GameStoreScript)
			return
	_refresh()


func get_view() -> Dictionary:
	return _view


func is_preview() -> bool:
	return not _preview_name.is_empty()


## The ending id on screen; empty when the view has none.
func get_ending_id() -> String:
	return EndingFormat.ending_id(EndingFormat.ending_of(_view))


## Every text on screen, top to bottom (for tests and accessibility checks).
func get_texts() -> PackedStringArray:
	return _collect(self)


func get_status_text() -> String:
	return _status.text


## True when the TruthRecap of `ending.recap` is on screen.
func has_recap() -> bool:
	return _recap_shown


## Opens the case board to look through the finished case.
func open_case_board() -> Error:
	var router: Node = get_node_or_null(^"/root/SceneRouter")
	if not router is SceneRouterScript:
		return ERR_UNCONFIGURED
	var params: Dictionary = {"back": "ending"}
	if is_preview():
		params["preview"] = "end"
	return (router as SceneRouterScript).goto(CASE_BOARD_SCREEN, params)


func _refresh() -> void:
	var requested: String = str(_params.get(PARAM_PREVIEW, ""))
	var has_live_view: bool = _store != null and _store.has_view()
	if requested.is_empty() and not _params_received and not has_live_view:
		requested = DEFAULT_PREVIEW
	if not requested.is_empty() and (_params.has(PARAM_PREVIEW) or not has_live_view):
		_preview_name = requested
		_show(EndingFixtures.view_for(requested))
		return
	_preview_name = ""
	_show(_store.get_view() if has_live_view else ReadOnly.empty())


func _show(view: Dictionary) -> void:
	var leaked: String = GameStoreScript.find_forbidden_key(view)
	if not leaked.is_empty():
		push_error("Ending: view with the server-only field '%s' is not shown" % leaked)
		view = ReadOnly.empty()
	_view = view
	_recap_shown = false
	var ending: Dictionary = EndingFormat.ending_of(view)
	var ending_id: String = EndingFormat.ending_id(ending)
	_clear(_proven)
	_clear(_recap)
	_clear(_stats)
	var over: bool = not ending_id.is_empty()
	_kind.visible = over
	_title.visible = over
	_text.visible = over
	_proven.visible = false
	_recap.visible = over
	_stats.visible = over
	_case_board.visible = over
	if view.is_empty():
		_status.text = (PREVIEW_FAILED_TEXT % _preview_name) if is_preview() else NO_VIEW_TEXT
		return
	if not over:
		_status.text = NOT_OVER_TEXT
		return
	_status.text = (PREVIEW_TEXT % _preview_name) if is_preview() else ""
	_kind.text = EndingFormat.kind_text(ending_id)
	_title.text = _or_missing(str(ending.get("title", "")))
	_text.text = str(ending.get("text", ""))

	var proven: Array[PackedStringArray] = EndingFormat.proven_rows(ending)
	if not proven.is_empty():
		_proven.visible = true
		_heading(_proven, PROVEN_TITLE)
		for row: PackedStringArray in proven:
			_add_label(_proven, "%s: %s" % [row[0], row[1]])

	_heading(_recap, RECAP_TITLE)
	var recap: Dictionary = EndingFormat.recap_of(ending)
	if recap.is_empty():
		_add_label(_recap, NO_RECAP_TEXT).modulate.a = 0.6
	else:
		_recap_shown = true
		_add_label(_recap, str(recap["summary"]))
		var names: Array = recap["responsible"]
		if not names.is_empty():
			_add_label(_recap, RESPONSIBLE_TEXT % ", ".join(PackedStringArray(names)))
		var timeline: PackedStringArray = EndingFormat.timeline_rows(ending)
		if not timeline.is_empty():
			_heading(_recap, TIMELINE_TITLE)
			for event: String in timeline:
				_add_label(_recap, event)

	var stats_title: Label = _add_label(_stats, STATS_TITLE)
	stats_title.add_theme_font_size_override(&"font_size", 24)
	_stats.add_child(Control.new())
	for row: PackedStringArray in EndingFormat.statistics_rows(view):
		_add_label(_stats, row[0]).modulate.a = 0.75
		_add_label(_stats, row[1])


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	_preview_name = ""
	_show(view)


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	# A dropped connection (RETRYING) keeps the final view: the session goes on. OFFLINE ends the
	# session: its ending and TruthRecap must not stay on screen for the next one.
	if state == BackendScript.ConnectionState.OFFLINE and not is_preview():
		_show(ReadOnly.empty())


func _build_ui() -> void:
	var background: ColorRect = ColorRect.new()
	background.color = Color(0.04, 0.04, 0.05, 1.0)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(background)
	var margin: MarginContainer = MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	for side: String in ["left", "right"]:
		margin.add_theme_constant_override("margin_" + side, 80)
	for side: String in ["top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 48)
	add_child(margin)
	var scroll: ScrollContainer = ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	margin.add_child(scroll)
	var layout: VBoxContainer = VBoxContainer.new()
	layout.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	layout.add_theme_constant_override(&"separation", 16)
	scroll.add_child(layout)

	_status = _add_label(layout, "")
	_status.name = "Status"
	_kind = _add_label(layout, "")
	_kind.name = "Kind"
	_kind.modulate.a = 0.7
	_kind.add_theme_font_size_override(&"font_size", 22)
	_title = _add_label(layout, "")
	_title.name = "Title"
	_title.add_theme_font_size_override(&"font_size", 48)
	_text = _add_label(layout, "")
	_text.name = "Text"
	_text.add_theme_font_size_override(&"font_size", 22)
	_proven = VBoxContainer.new()
	_proven.name = "Proven"
	layout.add_child(_proven)
	_recap = VBoxContainer.new()
	_recap.name = "Recap"
	layout.add_child(_recap)
	_stats = GridContainer.new()
	_stats.name = "Statistics"
	_stats.columns = 2
	_stats.add_theme_constant_override(&"h_separation", 24)
	layout.add_child(_stats)
	_case_board = Button.new()
	_case_board.name = "CaseBoard"
	_case_board.text = CASE_BOARD_TEXT
	_case_board.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
	_case_board.pressed.connect(func() -> void: open_case_board())
	layout.add_child(_case_board)


static func _or_missing(text: String) -> String:
	return text if not text.is_empty() else EndingFormat.MISSING


static func _heading(container: Container, text: String) -> void:
	_add_label(container, text).add_theme_font_size_override(&"font_size", 28)


static func _add_label(container: Container, text: String) -> Label:
	var label: Label = Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	container.add_child(label)
	return label


static func _clear(container: Container) -> void:
	for child: Node in container.get_children():
		container.remove_child(child)
		child.free()


static func _collect(node: Node) -> PackedStringArray:
	var found: PackedStringArray = PackedStringArray()
	if node is Label and (node as Label).visible:
		found.append((node as Label).text)
	elif node is Button and (node as Button).visible:
		found.append((node as Button).text)
	for child: Node in node.get_children():
		if child is CanvasItem and not (child as CanvasItem).visible:
			continue
		found.append_array(_collect(child))
	return found
