class_name DebugOverlay
extends CanvasLayer
## Developer panel on F12: seed, game time, stateVersion, the session truth and a repro export.
##
## Exists only in a debug build (feature tag `debug`): [method install] adds nothing in a release
## build, and an instance created there frees itself without building its UI or sending requests.
## The truth comes only from the server debug routes (SRV-009) with the session's desktop token;
## the server answers them only with `HS_DEBUG_TRUTH=1`. The truth stays in this node: it never
## goes to GameStore or a view, is never logged and is dropped when the panel closes or the session
## ends. Time and stateVersion are read from GameStore, as every screen does.
##
## The desktop client creates no session yet (GDT-003): whoever creates one passes its server
## address, id and desktop token to [method attach_session]. Until then the debug requests report
## that there is no session.

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const DebugApi = preload("res://src/scenes/overlays/debug/debug_api.gd")

## A debug request finished. [param kind] is `truth` or `export`.
signal request_finished(kind: String, ok: bool)
## The panel was opened or closed.
signal toggled(open: bool)

const DEBUG_FEATURE: String = "debug"
const TOGGLE_KEY: Key = KEY_F12
const NODE_NAME: String = "DebugOverlay"
const OVERLAY_LAYER: int = 128
const NO_VALUE: String = "—"

## Where [method request_export] writes repro bundles. They contain the solution.
var export_directory: String = "user://debug_repro"
## Writes the seed to the clipboard; tests replace it.
var clipboard_writer: Callable = Callable(DisplayServer, "clipboard_set")

var _forced_release: bool = false
var _backend: BackendScript
var _store: GameStoreScript
var _base_url: String = ""
var _session_id: String = ""
var _desktop_token: String = ""
## Bumped when the session changes, so a late answer for an old session is dropped.
var _generation: int = 0
## request id → [kind, generation]
var _pending: Dictionary = {}
var _seed: String = ""
var _scenario_id: String = ""
var _generator_version: String = ""
var _truth_text: String = ""
var _truth_revealed: bool = false
var _last_export_path: String = ""
var _status: String = ""

var _panel: PanelContainer
var _session_label: Label
var _seed_label: Label
var _time_label: Label
var _version_label: Label
var _status_label: Label
var _truth_view: TextEdit
var _reveal_button: Button


## True when this build carries the `debug` feature tag (editor runs and debug exports).
static func is_debug_build() -> bool:
	return OS.has_feature(DEBUG_FEATURE)


## Adds the overlay to [param root] in a debug build; returns null and adds nothing in a release
## build. A second call returns the overlay already installed.
static func install(root: Node) -> DebugOverlay:
	return _install_if(root, is_debug_build())


static func _install_if(root: Node, debug_build: bool) -> DebugOverlay:
	if not debug_build or root == null:
		return null
	var existing: Node = root.get_node_or_null(NodePath(NODE_NAME))
	if existing is DebugOverlay:
		return existing as DebugOverlay
	var overlay: DebugOverlay = DebugOverlay.new()
	overlay.name = NODE_NAME
	root.add_child.call_deferred(overlay)
	return overlay


func _ready() -> void:
	if not is_debug_build():
		set_process_input(false)
		queue_free()
		return
	if _forced_release:
		set_process_input(false)
		return
	layer = OVERLAY_LAYER
	process_mode = Node.PROCESS_MODE_ALWAYS
	_build_ui()
	if _backend == null:
		var backend: Node = get_node_or_null(^"/root/Backend")
		if backend is BackendScript:
			bind_backend(backend as BackendScript)
	if _store == null:
		var store: Node = get_node_or_null(^"/root/GameStore")
		if store is GameStoreScript:
			bind_store(store as GameStoreScript)
	_refresh()


## The panel can be used: a debug build that was not switched to release mode.
func is_available() -> bool:
	return is_debug_build() and not _forced_release


## Behaves as in a release build from now on (one way): closes the panel, forgets the session
## and refuses every request. Used by tests of the release behaviour.
func force_release_mode() -> void:
	close()
	detach_session()
	_forced_release = true
	set_process_input(false)


## Sends debug requests through [param backend] (the `Backend` autoload by default).
func bind_backend(backend: BackendScript) -> void:
	if _backend != null and is_instance_valid(_backend):
		if _backend.rest_completed.is_connected(_on_rest_completed):
			_backend.rest_completed.disconnect(_on_rest_completed)
	_backend = backend
	_pending.clear()
	if _backend != null:
		_backend.rest_completed.connect(_on_rest_completed)


## Reads time and stateVersion from [param store] (the `GameStore` autoload by default).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		if _store.view_changed.is_connected(_on_view_changed):
			_store.view_changed.disconnect(_on_view_changed)
		if _store.connection_state_changed.is_connected(_on_connection_state_changed):
			_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.connection_state_changed.connect(_on_connection_state_changed)
	_refresh()


## The session the debug routes are asked about: Session Server origin (`http://127.0.0.1:7420`),
## session id and the desktop token returned by `POST /sessions`. The token is kept in memory
## only and sent only as the `Authorization` header of the debug routes.
func attach_session(base_url: String, session_id: String, desktop_token: String) -> Error:
	if not is_available():
		return ERR_UNAVAILABLE
	if not DebugApi.is_base_url(base_url) or session_id.strip_edges().is_empty():
		return ERR_INVALID_PARAMETER
	if desktop_token.is_empty():
		return ERR_INVALID_PARAMETER
	_forget_session_data()
	_base_url = base_url.strip_edges()
	_session_id = session_id.strip_edges()
	_desktop_token = desktop_token
	_status = "Сессия подключена"
	_refresh()
	return OK


## Forgets the session, its token and everything received about it.
func detach_session() -> void:
	_forget_session_data()
	_base_url = ""
	_session_id = ""
	_desktop_token = ""
	_refresh()


func has_session() -> bool:
	return not _session_id.is_empty() and not _desktop_token.is_empty()


func is_open() -> bool:
	return _panel != null and _panel.visible


## Opens the panel; false in a release build.
func open() -> bool:
	if not is_available() or _panel == null:
		return false
	if not _panel.visible:
		_panel.visible = true
		_refresh()
		toggled.emit(true)
	return true


## Closes the panel and drops the truth received so far.
func close() -> void:
	_clear_truth()
	if _panel != null and _panel.visible:
		_panel.visible = false
		toggled.emit(false)
	_refresh()


func toggle() -> void:
	if is_open():
		close()
	else:
		open()


## Asks `GET /sessions/:id/debug/truth`: seed, scenario, generator version and the truth.
func request_truth() -> Error:
	return _request(DebugApi.TRUTH)


## Asks `GET /sessions/:id/debug/export` and writes the repro bundle to [member export_directory].
func request_export() -> Error:
	return _request(DebugApi.EXPORT)


## Copies the seed received from the debug routes to the clipboard.
func copy_seed() -> Error:
	if not is_available():
		return ERR_UNAVAILABLE
	if _seed.is_empty():
		_status = "Seed ещё не получен: запросите истину или экспорт"
		_refresh()
		return ERR_UNCONFIGURED
	clipboard_writer.call(_seed)
	_status = "Seed скопирован"
	_refresh()
	return OK


## Shows or hides the received truth inside the panel (hidden by default: it spoils the case).
func reveal_truth(reveal: bool) -> void:
	_truth_revealed = reveal and not _truth_text.is_empty()
	_refresh()


func is_truth_revealed() -> bool:
	return _truth_revealed


func get_seed() -> String:
	return _seed


func get_status() -> String:
	return _status


func get_last_export_path() -> String:
	return _last_export_path


## The truth as shown in the panel; empty when none was received or it was dropped.
func get_truth_text() -> String:
	return _truth_text


func get_time_text() -> String:
	return _time_label.text if _time_label != null else NO_VALUE


func get_state_version_text() -> String:
	return _version_label.text if _version_label != null else NO_VALUE


func get_seed_text() -> String:
	return _seed_label.text if _seed_label != null else NO_VALUE


func _input(event: InputEvent) -> void:
	if not is_available() or not event is InputEventKey:
		return
	var key: InputEventKey = event
	if key.pressed and not key.echo and key.keycode == TOGGLE_KEY:
		toggle()
		var viewport: Viewport = get_viewport()
		if viewport != null:
			viewport.set_input_as_handled()


func _request(kind: String) -> Error:
	if not is_available():
		return ERR_UNAVAILABLE
	if not has_session():
		_status = "Нет сессии: debug-запросы недоступны"
		_refresh()
		return ERR_UNCONFIGURED
	if _backend == null or not is_instance_valid(_backend):
		_status = "Backend недоступен"
		_refresh()
		return ERR_UNCONFIGURED
	var url: String = DebugApi.endpoint(_base_url, _session_id, kind)
	if url.is_empty():
		return ERR_INVALID_PARAMETER
	var request_id: int = _backend.request_rest(url, HTTPClient.METHOD_GET, "", _desktop_token)
	_pending[request_id] = [kind, _generation]
	_status = "Запрос %s…" % kind
	_refresh()
	return OK


func _on_rest_completed(request_id: int, result: int, status: int, body: Variant) -> void:
	if not _pending.has(request_id):
		return
	var entry: Array = _pending[request_id]
	_pending.erase(request_id)
	var kind: String = str(entry[0])
	var generation: int = entry[1]
	if not is_available() or generation != _generation:
		return
	if not DebugApi.is_valid_answer(kind, result, status, body):
		if kind == DebugApi.TRUTH:
			_clear_truth()
		_status = DebugApi.describe_failure(result, status)
		# Only the route kind and the status: never the body, the URL or the token.
		push_warning("DebugOverlay: debug %s request failed (result %d, HTTP %d)" % [kind, result, status])
		_refresh()
		request_finished.emit(kind, false)
		return
	var data: Dictionary = body
	_remember_identity(data)
	var ok: bool = true
	if kind == DebugApi.TRUTH:
		_truth_text = JSON.stringify(data.get("truth"), "  ")
		_truth_revealed = false
		_status = "Истина получена (скрыта, нажмите «Показать истину»)"
	else:
		ok = _write_export(data)
	_refresh()
	request_finished.emit(kind, ok)


func _remember_identity(data: Dictionary) -> void:
	_seed = str(data.get("seed", ""))
	_scenario_id = str(data.get("scenarioId", ""))
	_generator_version = str(data.get("generatorVersion", ""))


func _write_export(bundle: Dictionary) -> bool:
	var session: Variant = bundle.get("session")
	var version: int = -1
	if session is Dictionary:
		var session_data: Dictionary = session
		var raw_version: Variant = session_data.get("stateVersion")
		if raw_version is float or raw_version is int:
			var number: float = raw_version
			version = int(number)
	var directory: String = ProjectSettings.globalize_path(export_directory)
	var made: Error = DirAccess.make_dir_recursive_absolute(directory)
	if made != OK and made != ERR_ALREADY_EXISTS:
		_status = "Не удалось создать каталог экспорта (ошибка %d)" % made
		return false
	var path: String = directory.path_join(DebugApi.repro_file_name(_session_id, version))
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		_status = "Не удалось записать репро-пакет (ошибка %d)" % FileAccess.get_open_error()
		return false
	file.store_string(JSON.stringify(bundle, "\t"))
	file.close()
	_last_export_path = path
	_status = "Репро-пакет сохранён: %s" % path
	return true


func _on_view_changed(_view: Dictionary, _state_version: int) -> void:
	_refresh()


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	# OFFLINE comes only after Backend.disconnect_session(): the session ended or was replaced.
	if state == BackendScript.ConnectionState.OFFLINE:
		detach_session()


func _forget_session_data() -> void:
	_generation += 1
	_pending.clear()
	_seed = ""
	_scenario_id = ""
	_generator_version = ""
	_last_export_path = ""
	_status = ""
	_clear_truth()


func _clear_truth() -> void:
	_truth_text = ""
	_truth_revealed = false
	if _truth_view != null:
		_truth_view.text = ""


func _refresh() -> void:
	if _panel == null:
		return
	if has_session():
		_session_label.text = "Сессия: %s @ %s" % [_session_id, _base_url]
	else:
		_session_label.text = "Сессия: нет (debug-запросы недоступны)"
	var identity: String = _seed if not _seed.is_empty() else NO_VALUE
	if not _scenario_id.is_empty():
		identity += "  · %s · generator %s" % [_scenario_id, _generator_version]
	_seed_label.text = "Seed: %s" % identity
	_time_label.text = "Время: %s" % _clock_text()
	var version: int = _store.get_state_version() if _store != null and is_instance_valid(_store) else -1
	_version_label.text = "stateVersion: %s" % (str(version) if version >= 0 else NO_VALUE)
	_status_label.text = _status
	_truth_view.text = _truth_text if _truth_revealed else ""
	_truth_view.visible = _truth_revealed
	_reveal_button.disabled = _truth_text.is_empty()
	_reveal_button.text = "Скрыть истину" if _truth_revealed else "Показать истину"


func _clock_text() -> String:
	if _store == null or not is_instance_valid(_store) or not _store.has_view():
		return NO_VALUE
	var view: Dictionary = _store.get_view()
	var raw_clock: Variant = view.get("clock")
	if not raw_clock is Dictionary:
		return NO_VALUE
	var clock: Dictionary = raw_clock
	var text: String = "день %s, %s" % [_integer(clock.get("day")), str(clock.get("time", NO_VALUE))]
	text += " (t=%s, осталось %s мин)" % [_integer(clock.get("t")), _integer(clock.get("remainingMinutes"))]
	return text


static func _integer(value: Variant) -> String:
	if value is float or value is int:
		var number: float = value
		return str(int(number))
	return NO_VALUE


func _build_ui() -> void:
	_panel = PanelContainer.new()
	_panel.name = "Panel"
	_panel.visible = false
	_panel.anchor_left = 1.0
	_panel.anchor_right = 1.0
	_panel.offset_left = -660.0
	_panel.offset_right = -20.0
	_panel.offset_top = 20.0
	_panel.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	add_child(_panel)

	var margin: MarginContainer = MarginContainer.new()
	for side: String in ["margin_left", "margin_right", "margin_top", "margin_bottom"]:
		margin.add_theme_constant_override(side, 12)
	_panel.add_child(margin)
	var column: VBoxContainer = VBoxContainer.new()
	column.add_theme_constant_override("separation", 6)
	margin.add_child(column)

	var title: Label = Label.new()
	title.text = "Debug (F12)"
	column.add_child(title)
	_session_label = _add_label(column, "SessionLabel")
	_seed_label = _add_label(column, "SeedLabel")
	_time_label = _add_label(column, "TimeLabel")
	_version_label = _add_label(column, "VersionLabel")

	var buttons: HFlowContainer = HFlowContainer.new()
	column.add_child(buttons)
	_add_button(buttons, "CopySeedButton", "Копировать seed", _on_copy_seed_pressed)
	_add_button(buttons, "TruthButton", "Запросить истину", _on_truth_pressed)
	_reveal_button = _add_button(buttons, "RevealButton", "Показать истину", _on_reveal_pressed)
	_add_button(buttons, "ExportButton", "Экспорт репро", _on_export_pressed)
	_add_button(buttons, "CloseButton", "Закрыть", close)

	_status_label = _add_label(column, "StatusLabel")
	_truth_view = TextEdit.new()
	_truth_view.name = "TruthView"
	_truth_view.editable = false
	_truth_view.visible = false
	_truth_view.custom_minimum_size = Vector2(0.0, 420.0)
	column.add_child(_truth_view)


func _add_label(parent: Control, node_name: String) -> Label:
	var label: Label = Label.new()
	label.name = node_name
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	parent.add_child(label)
	return label


func _add_button(parent: Control, node_name: String, text: String, handler: Callable) -> Button:
	var button: Button = Button.new()
	button.name = node_name
	button.text = text
	button.focus_mode = Control.FOCUS_NONE
	button.pressed.connect(handler)
	parent.add_child(button)
	return button


func _on_copy_seed_pressed() -> void:
	copy_seed()


func _on_truth_pressed() -> void:
	request_truth()


func _on_reveal_pressed() -> void:
	reveal_truth(not _truth_revealed)


func _on_export_pressed() -> void:
	request_export()
