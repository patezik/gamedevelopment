extends Control
## NewGame: the scenario catalog, a random or entered seed and session creation
## (godot-client.md §4.6, backend.md §3, protocol.md §7).
##
## The catalog comes from `GET /scenarios`, the session from `POST /sessions`. With a random seed
## the request carries no seed and the server keeps it to itself. On success the session becomes
## [PairingSession] current, Backend opens the desktop WebSocket with its token and SceneRouter
## shows Pairing. The token never reaches SceneRouter params or the screen.

const BackendScript = preload("res://src/autoload/backend.gd")
const LauncherScript = preload("res://src/autoload/server_launcher.gd")
const Format = preload("res://src/scenes/new_game/new_game_format.gd")

const PAIRING_SCREEN: StringName = &"pairing"
const TITLE_TEXT: String = "Новая игра"
const SCENARIO_TEXT: String = "Сценарий"
const SEED_TEXT: String = "Seed"
const RANDOM_SEED_TEXT: String = "Случайный seed"
const SEED_PLACEHOLDER: String = "например, winter-42"
const SEED_HINT: String = "Одинаковый seed со сценарием и версией игры даёт то же дело."
const SEED_REQUIRED: String = "Введите seed или включите случайный."
const CREATE_TEXT: String = "Создать дело"
const RELOAD_TEXT: String = "Обновить список"
const LOADING_TEXT: String = "Загрузка сценариев…"
const STARTING_TEXT: String = "Запускаем сервер игры…"
const CREATING_TEXT: String = "Создаём дело… Генерация может занять несколько секунд."
const READY_TEXT: String = "Сервер: %s"
const ERROR_COLOR: Color = Color(1.0, 0.45, 0.4, 1.0)

enum Phase { LOADING, READY, CATALOG_FAILED, CREATING, DONE }

## Command-line user arguments (after `--`); tests replace them before the node enters the tree.
var user_args: PackedStringArray = OS.get_cmdline_user_args()

var _backend: BackendScript
var _router: Node
## The packaged server (INT-005); null or IDLE when the game runs without one (editor, tests).
var _launcher: LauncherScript
var _waiting_for_launcher: bool = false
var _params: Dictionary = {}
var _origin: String = Format.DEFAULT_ORIGIN
var _phase: Phase = Phase.LOADING
var _scenarios: Array[Dictionary] = []
var _catalog_request: int = -1
var _create_request: int = -1

var _status: Label
var _error: Label
var _language_heading: Label
var _language: OptionButton
var _scenario: OptionButton
var _random_seed: CheckButton
var _seed: LineEdit
var _seed_error: Label
var _create: Button
var _reload: Button


## SceneRouter params: optional `server` (`http://host:port`) overrides the server address.
func set_params(params: Dictionary) -> void:
	_params = params


## Uses [param backend] and [param router] instead of the Backend and SceneRouter autoloads.
## Call before the node enters the tree.
func bind_sources(backend: BackendScript, router: Node) -> void:
	_backend = backend
	_router = router


## Uses [param launcher] instead of the ServerLauncher autoload. Call before the node enters the tree.
func bind_launcher(launcher: LauncherScript) -> void:
	_launcher = launcher


func _ready() -> void:
	if _backend == null:
		_backend = get_node(^"/root/Backend") as BackendScript
	if _router == null:
		_router = get_node_or_null(^"/root/SceneRouter")
	if _launcher == null:
		_launcher = get_node_or_null(^"/root/ServerLauncher") as LauncherScript
	var bundled: bool = (
		_launcher != null and _launcher.state != LauncherScript.State.IDLE
		and Format.explicit_origin(_params, user_args).is_empty()
	)
	_origin = Format.server_origin(_params, user_args, _launcher.base_url() if bundled else "")
	_build_ui()
	_backend.rest_completed.connect(_on_rest_completed)
	Settings.locale_changed.connect(_on_locale_changed)
	if bundled and _launcher.state == LauncherScript.State.STARTING:
		# The catalog is asked for only after /health answered on the port the launcher chose.
		_waiting_for_launcher = true
		_launcher.server_ready.connect(_on_launcher_ready, CONNECT_ONE_SHOT)
		_launcher.server_failed.connect(_on_launcher_failed, CONNECT_ONE_SHOT)
		_refresh()
	elif bundled and _launcher.state == LauncherScript.State.FAILED:
		_fail_catalog(Format.LAUNCH_FAILED)
	else:
		load_catalog()


func _on_launcher_ready(_port: int) -> void:
	if not _waiting_for_launcher:
		return
	_waiting_for_launcher = false
	if _launcher.server_failed.is_connected(_on_launcher_failed):
		_launcher.server_failed.disconnect(_on_launcher_failed)
	load_catalog()


func _on_launcher_failed(_reason: String) -> void:
	if not _waiting_for_launcher:
		return
	_waiting_for_launcher = false
	if _launcher.server_ready.is_connected(_on_launcher_ready):
		_launcher.server_ready.disconnect(_on_launcher_ready)
	_fail_catalog(Format.LAUNCH_FAILED)


func _exit_tree() -> void:
	if Settings.locale_changed.is_connected(_on_locale_changed):
		Settings.locale_changed.disconnect(_on_locale_changed)
	for request_id: int in [_catalog_request, _create_request]:
		if request_id >= 0 and is_instance_valid(_backend):
			_backend.cancel_queued_rest(request_id)
	_catalog_request = -1
	_create_request = -1


func get_phase() -> Phase:
	return _phase


func get_origin() -> String:
	return _origin


## Requests `GET /scenarios`; a request already in flight is kept.
func load_catalog() -> void:
	if _catalog_request >= 0 or _phase == Phase.CREATING or _phase == Phase.DONE:
		return
	_phase = Phase.LOADING
	_error.text = ""
	_catalog_request = _backend.request_rest(_origin + "/api/v1/scenarios")
	_refresh()


## Sends `POST /sessions` for the selected scenario. Ignored while the catalog loads, while a
## creation is in flight or when the seed is invalid. Returns true if a request was sent.
func create_session() -> bool:
	if _phase != Phase.READY or not _can_create():
		return false
	var scenario: Dictionary = _scenarios[_scenario.selected]
	var seed: String = "" if _random_seed.button_pressed else _seed.text
	_phase = Phase.CREATING
	_error.text = ""
	_create_request = _backend.request_rest(
		_origin + "/api/v1/sessions", HTTPClient.METHOD_POST,
		Format.request_body(str(scenario["id"]), seed, Settings.get_locale())
	)
	_refresh()
	return true


func _can_create() -> bool:
	if _scenarios.is_empty() or _scenario.selected < 0:
		return false
	return _random_seed.button_pressed or Format.is_valid_seed(_seed.text)


func _on_rest_completed(request_id: int, result: int, status: int, body: Variant) -> void:
	if request_id < 0:
		return
	if request_id == _catalog_request:
		_catalog_request = -1
		_on_catalog(result, status, body)
	elif request_id == _create_request:
		_create_request = -1
		_on_created(result, status, body)


func _on_catalog(result: int, status: int, body: Variant) -> void:
	if result != HTTPRequest.RESULT_SUCCESS or status != 200:
		_fail_catalog(Format.catalog_error_text(result, status, _origin))
		return
	var previous: String = ""
	if not _scenarios.is_empty() and _scenario.selected >= 0:
		previous = str(_scenarios[_scenario.selected]["id"])
	_scenarios = Format.parse_scenarios(body)
	if _scenarios.is_empty():
		_fail_catalog(Format.CATALOG_EMPTY)
		return
	_scenario.clear()
	var selected: int = 0
	for index: int in range(_scenarios.size()):
		_scenario.add_item(Format.scenario_label(_scenarios[index]), index)
		if str(_scenarios[index]["id"]) == previous:
			selected = index
	_scenario.select(selected)
	if _phase == Phase.LOADING:
		_phase = Phase.READY
	_refresh()


func _fail_catalog(message: String) -> void:
	_scenarios.clear()
	_scenario.clear()
	_phase = Phase.CATALOG_FAILED
	_error.text = message
	_refresh()


func _on_created(result: int, status: int, body: Variant) -> void:
	var session: PairingSession = null
	if result == HTTPRequest.RESULT_SUCCESS and status == 201:
		session = PairingSession.from_response(_origin, body)
	if session == null:
		_phase = Phase.READY
		var message: String = Format.CREATE_BAD_ANSWER
		if result != HTTPRequest.RESULT_SUCCESS or status != 201:
			message = Format.create_error_text(result, status, body)
		_error.text = message
		_refresh()
		if Format.error_code(body) == "SCENARIO_NOT_FOUND":
			load_catalog()
			_error.text = message
		return
	_phase = Phase.DONE
	_refresh()
	PairingSession.set_current(session)
	_backend.connect_session(session.ws_url(), session.desktop_token())
	# The debug panel (debug builds only) asks the server about this session (godot-client.md §3.3).
	var overlay: Node = get_tree().root.get_node_or_null(^"DebugOverlay")
	if overlay != null and overlay.has_method(&"attach_session"):
		overlay.call(&"attach_session", session.origin, session.session_id, session.desktop_token())
	if _router != null and _router.has_method(&"goto"):
		_router.call(&"goto", PAIRING_SCREEN)


func _refresh() -> void:
	var busy: bool = _phase == Phase.CREATING or _phase == Phase.DONE
	match _phase:
		Phase.LOADING:
			_status.text = STARTING_TEXT if _waiting_for_launcher else LOADING_TEXT
		Phase.CREATING, Phase.DONE:
			_status.text = CREATING_TEXT
		_:
			_status.text = READY_TEXT % _origin
	var seed_invalid: bool = not _random_seed.button_pressed and not Format.is_valid_seed(_seed.text)
	if not seed_invalid:
		_seed_error.text = ""
	elif _seed.text.is_empty():
		_seed_error.text = SEED_REQUIRED
	else:
		_seed_error.text = Format.SEED_INVALID
	_scenario.disabled = busy or _scenarios.is_empty()
	_random_seed.disabled = busy
	_seed.editable = not busy and not _random_seed.button_pressed
	_create.disabled = _phase != Phase.READY or not _can_create()
	_reload.visible = _phase == Phase.CATALOG_FAILED
	_reload.disabled = _catalog_request >= 0


## Language picker: the locales come from [constant Settings.SUPPORTED_LOCALES], every one is shown
## under its own name (`language.<locale>` in the string table).
func _fill_languages() -> void:
	_language.clear()
	for index: int in range(Settings.SUPPORTED_LOCALES.size()):
		var locale: String = Settings.SUPPORTED_LOCALES[index]
		_language.add_item(Localization.text("language." + locale, locale), index)
		if locale == Settings.get_locale():
			_language.select(index)


func _on_language_selected(index: int) -> void:
	Settings.set_locale(Settings.SUPPORTED_LOCALES[index])


func _on_locale_changed(_locale: String) -> void:
	_redraw_language()


func _redraw_language() -> void:
	_language_heading.text = Localization.text("settings.language")
	_fill_languages()


func _on_seed_mode_toggled(_random: bool) -> void:
	_refresh()
	if not _random_seed.button_pressed:
		_seed.grab_focus()


func _on_seed_changed(_text: String) -> void:
	_refresh()


func _on_seed_submitted(_text: String) -> void:
	create_session()


# --- widgets -----------------------------------------------------------------------------------


func _build_ui() -> void:
	var background: ColorRect = ColorRect.new()
	background.color = Color(0.07, 0.06, 0.07, 1.0)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(background)
	var center: CenterContainer = CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(center)
	var layout: VBoxContainer = VBoxContainer.new()
	layout.custom_minimum_size = Vector2(720, 0)
	layout.add_theme_constant_override(&"separation", 14)
	center.add_child(layout)

	var title: Label = Label.new()
	title.text = TITLE_TEXT
	title.add_theme_font_size_override(&"font_size", 40)
	layout.add_child(title)
	_status = _label(layout, "")
	_status.name = "Status"
	_error = _label(layout, "")
	_error.name = "Error"
	_error.add_theme_color_override(&"font_color", ERROR_COLOR)

	_language_heading = _label(layout, "")
	_language_heading.name = "LanguageHeading"
	_language_heading.add_theme_font_size_override(&"font_size", 24)
	_language = OptionButton.new()
	_language.name = "Language"
	_language.item_selected.connect(_on_language_selected)
	layout.add_child(_language)
	_redraw_language()

	_heading(layout, SCENARIO_TEXT)
	_scenario = OptionButton.new()
	_scenario.name = "Scenario"
	_scenario.item_selected.connect(func(_index: int) -> void: _refresh())
	layout.add_child(_scenario)

	_heading(layout, SEED_TEXT)
	_random_seed = CheckButton.new()
	_random_seed.name = "RandomSeed"
	_random_seed.text = RANDOM_SEED_TEXT
	_random_seed.button_pressed = true
	_random_seed.toggled.connect(_on_seed_mode_toggled)
	layout.add_child(_random_seed)
	_seed = LineEdit.new()
	_seed.name = "Seed"
	_seed.max_length = Format.SEED_MAX_LENGTH
	_seed.placeholder_text = SEED_PLACEHOLDER
	_seed.text_changed.connect(_on_seed_changed)
	_seed.text_submitted.connect(_on_seed_submitted)
	layout.add_child(_seed)
	_seed_error = _label(layout, "")
	_seed_error.name = "SeedError"
	_seed_error.add_theme_color_override(&"font_color", ERROR_COLOR)
	var hint: Label = _label(layout, SEED_HINT)
	hint.modulate.a = 0.7

	var buttons: HBoxContainer = HBoxContainer.new()
	buttons.add_theme_constant_override(&"separation", 16)
	layout.add_child(buttons)
	_create = Button.new()
	_create.name = "Create"
	_create.text = CREATE_TEXT
	_create.pressed.connect(func() -> void: create_session())
	buttons.add_child(_create)
	_reload = Button.new()
	_reload.name = "Reload"
	_reload.text = RELOAD_TEXT
	_reload.pressed.connect(load_catalog)
	buttons.add_child(_reload)
	_refresh()


static func _label(container: Container, text: String) -> Label:
	var label: Label = Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	container.add_child(label)
	return label


static func _heading(container: Container, text: String) -> void:
	var label: Label = _label(container, text)
	label.add_theme_font_size_override(&"font_size", 24)
