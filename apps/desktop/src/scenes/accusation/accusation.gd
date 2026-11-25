extends Control
## Accusation screen (godot-client.md §4.4, game-design.md §5): the player names the accused,
## claims a motive, the means and the opportunity, attaches clues and confirms twice.
##
## The choice is offered from the PlayerView in GameStore only: characters the view names and the
## clues of `caseBoard`. The screen judges nothing (ADR 0002): it does not tell which claims hold
## or which ending follows. The accusation goes out as the `accuse` action of protocol.md §4 in
## two steps, as ENG-006 defines them:
##
## 1. "Обвинить" opens the first confirmation; on "yes" the screen sends `confirm: false`, which
##    only asks the server to confirm and changes nothing.
## 2. When the server accepts that request, the final confirmation opens; on "yes" the screen sends
##    the same case file with `confirm: true` — the irreversible accusation.
##
## Cancelling either confirmation sends nothing more. While a request is in flight every control
## is locked, so an accusation cannot go out twice. A refusal shows the error and keeps the
## choice. If the game ended, the server's view carries `ending` and the screen opens the `ending`
## screen; if the game goes on (a first wrong accusation with time left), the screen says so.
##
## A SceneRouter screen (`accusation`). Route params: `{"back": "<screen>", "backParams": {...}}`
## shows a back button; `{"preview": "<fixture>"}` renders a PlayerView fixture without a session
## server (as the scene does when run on its own); a preview never sends the accusation.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const AccusationFormat = preload("res://src/scenes/accusation/accusation_format.gd")
const EndingWatcher = preload("res://src/scenes/ending/ending_watcher.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

## Where the accusation stands.
enum Stage {
	## The player is choosing; nothing is in flight.
	EDITING,
	## The first confirmation is open; nothing was sent.
	CONFIRMING,
	## `confirm: false` was sent; waiting for the server.
	PROBING,
	## The server asked to confirm; the final confirmation is open.
	FINAL,
	## `confirm: true` was sent; waiting for the server.
	SUBMITTING,
	## The server accepted the accusation; waiting for the view that follows it.
	AWAITING_VIEW,
	## The game is over (the view carries `ending`); nothing more can be sent.
	ENDED,
}

const PARAM_PREVIEW: String = "preview"
const PARAM_BACK: String = "back"
const PARAM_BACK_PARAMS: String = "backParams"
const META_ID: StringName = &"id"

const TITLE_TEXT: String = "Обвинение"
const BACK_TEXT: String = "← Назад"
const ACCUSED_TITLE: String = "Обвиняемые"
const CLAIMS_TITLE: String = "Мотив, средство, возможность"
const EVIDENCE_TITLE: String = "Улики"
const ACCUSE_TEXT: String = "Обвинить…"
const NONE_TEXT: String = "— не указывать —"
const MOTIVE_SUBJECT_TEXT: String = "Мотив у"
const MOTIVE_TARGET_TEXT: String = "против"
const MEANS_TEXT: String = "Средство у"
const OPPORTUNITY_TEXT: String = "Возможность у"
const NO_CHARACTERS_TEXT: String = "Вы ещё не знаете никого, кого можно обвинить."
const NO_CLUES_TEXT: String = "Улик в деле нет."
const NO_VIEW_TEXT: String = "Нет данных дела: ожидание состояния от сервера."
const PREVIEW_TEXT: String = "Предпросмотр без сервера: фикстура %s. Обвинение не отправляется."
const PREVIEW_FAILED_TEXT: String = "Предпросмотр недоступен: фикстура «%s» не загружена."
const NEED_ACCUSED_TEXT: String = "Выберите хотя бы одного обвиняемого."
const NEED_TARGET_TEXT: String = "Укажите, против кого был мотив, или не указывайте мотив."
const PROBING_TEXT: String = "Запрос подтверждения у сервера…"
const SUBMITTING_TEXT: String = "Обвинение предъявлено. Ожидание решения…"
const CONTINUED_TEXT: String = "Обвинение не закрыло дело. Расследование продолжается."
const ENDED_TEXT: String = "Игра окончена."
const FIRST_CONFIRM_TITLE: String = "Предъявить обвинение?"
const FIRST_CONFIRM_TEXT: String = "Вы обвиняете: %s.\n%s\nУлик приложено: %d.%s"
const MISSING_TEXT: String = "\nНе указано: %s."
const FINAL_CONFIRM_TITLE: String = "Последнее подтверждение"
const FINAL_CONFIRM_TEXT: String = "Обвинение необратимо. Отменить его будет нельзя.\nПредъявить обвинение: %s?"
const CLAIM_LINE_TEXT: String = "%s: %s"
const NOT_SET_TEXT: String = "не указано"
const ERROR_TEXT: Dictionary = {
	ProtocolConstants.ERROR_ACTION_INVALID: "Сервер отклонил обвинение: проверьте обвиняемых и улики.",
	ProtocolConstants.ERROR_ACTION_NOT_AVAILABLE: "Обвинение сейчас недоступно.",
	ProtocolConstants.ERROR_ACTION_BLOCKED: "Обвинение заблокировано.",
	ProtocolConstants.ERROR_GAME_OVER: "Игра окончена.",
	ProtocolConstants.ERROR_RATE_LIMITED: "Слишком много запросов, попробуйте позже.",
	GameStoreScript.ERROR_NOT_CONNECTED: "Нет соединения с сервером.",
}
const ERROR_FALLBACK_TEXT: String = "Не удалось предъявить обвинение (%s)."
const CONNECTION_LOST_TEXT: String = "Связь с сервером прервана. Результат придёт с состоянием сервера."

var _store: GameStoreScript = null
var _params: Dictionary = ReadOnly.empty()
var _params_received: bool = false
var _preview_name: String = ""
var _preview_failed: bool = false
var _view: Dictionary = ReadOnly.empty()
var _stage: Stage = Stage.EDITING
var _request_id: String = ""
## The case file being confirmed or in flight; the choice may not change meanwhile.
var _file: Dictionary = {}

# The player's choice. It survives view updates and refusals; ids the view no longer names drop.
var _accused: Array[String] = []
var _subjects: Dictionary = {"motive": "", "means": "", "opportunity": ""}
var _motive_target: String = ""
var _evidence: Array[String] = []

var _characters: Array[Dictionary] = []
var _clues: Array[Dictionary] = []
var _signature: Array = []
var _names: Dictionary = {}

var _status: Label
var _error: Label
var _back: Button
var _content: Control
var _accused_box: VBoxContainer
var _claims_box: GridContainer
var _evidence_box: VBoxContainer
var _subject_options: Dictionary = {}
var _target_option: OptionButton
var _accuse: Button
var _first_confirm: ConfirmationDialog
var _final_confirm: ConfirmationDialog


## Called by SceneRouter before _ready. A screen that never gets params was run on its own.
func set_params(params: Dictionary) -> void:
	_params = params
	_params_received = true


## Listens to [param store] instead of the GameStore autoload (tests pass their own store).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.action_failed.disconnect(_on_action_failed)
		_store.action_resolved.disconnect(_on_action_resolved)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.action_failed.connect(_on_action_failed)
		_store.action_resolved.connect(_on_action_resolved)
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


# --- public API (also used by tests) -----------------------------------------------------------


func get_stage() -> Stage:
	return _stage


func get_view() -> Dictionary:
	return _view


func is_preview() -> bool:
	return not _preview_name.is_empty()


## Characters the screen offers (`{"id", "name"}`), in the order of the view.
func get_characters() -> Array[Dictionary]:
	return _characters.duplicate(true)


## Clue ids the screen offers to attach, in the order of the view.
func get_clue_ids() -> Array[String]:
	var ids: Array[String] = []
	for clue: Dictionary in _clues:
		ids.append(str(clue.get("id")))
	return ids


func get_error_text() -> String:
	return _error.text if _error != null else ""


func get_status_text() -> String:
	return _status.text if _status != null else ""


func get_first_dialog() -> ConfirmationDialog:
	return _first_confirm


func get_final_dialog() -> ConfirmationDialog:
	return _final_confirm


func get_accuse_button() -> Button:
	return _accuse


## Selects the accused (ids the view does not name are ignored). Claims about someone no longer
## accused are cleared.
func set_accused(ids: Array[String]) -> void:
	if not _editable():
		return
	_accused.clear()
	for character_id: String in ids:
		if _knows_character(character_id) and not _accused.has(character_id):
			_accused.append(character_id)
	_prune_claims()
	_sync_controls()


func get_accused() -> Array[String]:
	return _accused.duplicate()


## Claims [param part] ("motive", "means", "opportunity") about [param subject], one of the
## accused; an empty subject leaves the part out. [param target] is whom the motive is against.
func set_claim(part: String, subject: String, target: String = "") -> void:
	if not _editable() or not AccusationFormat.PARTS.has(part):
		return
	_subjects[part] = subject if _accused.has(subject) else ""
	if part == "motive":
		_motive_target = target if _knows_character(target) else ""
	_sync_controls()


## Attaches the clues [param ids] (ids the view does not hold are ignored).
func set_evidence(ids: Array[String]) -> void:
	if not _editable():
		return
	var known: Array[String] = get_clue_ids()
	_evidence.clear()
	for clue_id: String in ids:
		if known.has(clue_id) and not _evidence.has(clue_id):
			_evidence.append(clue_id)
	_sync_controls()


## The `caseFile` the current choice makes (protocol.md §4).
func get_case_file() -> Dictionary:
	var claims: Dictionary = {}
	for part: String in AccusationFormat.PARTS:
		claims[part] = AccusationFormat.claim_ref(part, str(_subjects[part]), _motive_target)
	return AccusationFormat.case_file(_accused, claims, _evidence)


## "Обвинить": checks that the choice is complete enough to send and opens the first
## confirmation. Returns ERR_BUSY while a request is in flight or a confirmation is open,
## ERR_UNAVAILABLE in a preview or after the game ended, ERR_INVALID_DATA for an incomplete choice.
func request_accusation() -> Error:
	if _stage != Stage.EDITING:
		return ERR_UNAVAILABLE if _stage == Stage.ENDED else ERR_BUSY
	if is_preview() or _view.is_empty():
		return ERR_UNAVAILABLE
	_error.text = ""
	if _accused.is_empty():
		_error.text = NEED_ACCUSED_TEXT
		return ERR_INVALID_DATA
	if not str(_subjects["motive"]).is_empty() and _motive_target.is_empty():
		_error.text = NEED_TARGET_TEXT
		return ERR_INVALID_DATA
	_file = get_case_file()
	_first_confirm.dialog_text = _first_confirm_text(_file)
	_set_stage(Stage.CONFIRMING)
	_first_confirm.popup_centered()
	return OK


# --- confirmation flow -------------------------------------------------------------------------


func _on_first_confirmed() -> void:
	if _stage != Stage.CONFIRMING:
		return
	# Closed before the final confirmation can open: only one exclusive dialog at a time.
	_first_confirm.hide()
	_send(false)


func _on_final_confirmed() -> void:
	if _stage != Stage.FINAL:
		return
	_final_confirm.hide()
	_send(true)


func _on_confirm_canceled() -> void:
	if _stage == Stage.CONFIRMING or _stage == Stage.FINAL:
		_file = {}
		_set_stage(Stage.EDITING)


func _send(confirm: bool) -> void:
	if _store == null:
		_fail(GameStoreScript.ERROR_NOT_CONNECTED, "")
		return
	_request_id = ""
	_set_stage(Stage.SUBMITTING if confirm else Stage.PROBING)
	# A refusal before sending comes back synchronously as action_failed (no request id yet).
	if _store.request_action(AccusationFormat.accuse_action(_file, confirm)) != OK:
		return
	_request_id = _store.get_last_action_request_id()


func _on_action_resolved(request_id: String, ok: bool, code: String, message: String) -> void:
	if _request_id.is_empty() or request_id != _request_id:
		return
	_request_id = ""
	if not ok:
		_fail(code, message)
		return
	if _stage == Stage.PROBING:
		_final_confirm.dialog_text = FINAL_CONFIRM_TEXT % _accused_names(_file)
		_set_stage(Stage.FINAL)
		_final_confirm.popup_centered()
	elif _stage == Stage.SUBMITTING:
		# The view that follows tells whether the game ended.
		_set_stage(Stage.AWAITING_VIEW)


func _on_action_failed(code: String, message: String) -> void:
	# Only a refusal before the request left (no id yet); a server refusal also arrives as
	# action_resolved for our request id.
	if (_stage == Stage.PROBING or _stage == Stage.SUBMITTING) and _request_id.is_empty():
		_fail(code, message)


func _fail(code: String, message: String) -> void:
	_request_id = ""
	_file = {}
	_first_confirm.hide()
	_final_confirm.hide()
	var text: String = str(ERROR_TEXT.get(code, ERROR_FALLBACK_TEXT % code))
	if not message.is_empty():
		text += " " + message
	_set_stage(Stage.EDITING)
	_error.text = text


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	_preview_name = ""
	_preview_failed = false
	var continued: bool = _stage == Stage.AWAITING_VIEW and not view.has("ending")
	_show(view)
	if continued:
		_file = {}
		_set_stage(Stage.EDITING)
		_status.text = CONTINUED_TEXT


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.ONLINE or _stage == Stage.ENDED:
		return
	if _stage == Stage.PROBING or _stage == Stage.SUBMITTING or _stage == Stage.AWAITING_VIEW:
		_request_id = ""
		_file = {}
		_set_stage(Stage.EDITING)
		_error.text = CONNECTION_LOST_TEXT
	if state == BackendScript.ConnectionState.OFFLINE and not is_preview():
		_show(ReadOnly.empty())


func _on_back_pressed() -> void:
	if _in_flight():
		return
	var back: String = _text(_params.get(PARAM_BACK))
	var router: Node = get_node_or_null(^"/root/SceneRouter")
	if back.is_empty() or not router is SceneRouterScript:
		return
	var back_params: Dictionary = {}
	if _params.get(PARAM_BACK_PARAMS) is Dictionary:
		back_params = _params[PARAM_BACK_PARAMS]
	(router as SceneRouterScript).goto(StringName(back), back_params)


# --- view --------------------------------------------------------------------------------------


func _refresh() -> void:
	var requested: String = _text(_params.get(PARAM_PREVIEW))
	var has_live_view: bool = _store != null and _store.has_view()
	if requested.is_empty() and not _params_received and not has_live_view:
		requested = PreviewFixtures.DEFAULT_NAME
	if not requested.is_empty() and (_params.has(PARAM_PREVIEW) or not has_live_view):
		var fixture: Dictionary = PreviewFixtures.load_view(requested)
		_preview_name = requested
		_preview_failed = fixture.is_empty()
		_show(fixture)
		return
	_preview_name = ""
	_preview_failed = false
	_show(_store.get_view() if has_live_view else ReadOnly.empty())


func _show(view: Dictionary) -> void:
	var leaked: String = GameStoreScript.find_forbidden_key(view)
	if not leaked.is_empty():
		push_error("Accusation: view with the server-only field '%s' is not shown" % leaked)
		view = ReadOnly.empty()
	_view = view
	_characters = AccusationFormat.known_characters(view)
	_clues = AccusationFormat.clues(view)
	for character: Dictionary in _characters:
		_names[str(character["id"])] = str(character["name"])
	if not _in_flight() and _stage != Stage.ENDED:
		_drop_unknown()
	var signature: Array = [_characters, _clues.map(_clue_signature)]
	if signature != _signature:
		_signature = signature.duplicate(true)
		_rebuild()
	if view.has("ending"):
		_set_stage(Stage.ENDED)
		_status.text = ENDED_TEXT
		if not is_preview():
			EndingWatcher.open_ending(get_node_or_null(^"/root/SceneRouter"))
		return
	_render_status()
	_sync_controls()


func _render_status() -> void:
	if _view.is_empty():
		_status.text = (PREVIEW_FAILED_TEXT % _preview_name) if _preview_failed else NO_VIEW_TEXT
	elif is_preview():
		_status.text = PREVIEW_TEXT % _preview_name
	elif _stage == Stage.PROBING:
		_status.text = PROBING_TEXT
	elif _stage == Stage.SUBMITTING or _stage == Stage.AWAITING_VIEW:
		_status.text = SUBMITTING_TEXT
	else:
		_status.text = ""


func _set_stage(stage: Stage) -> void:
	_stage = stage
	if _status != null and stage != Stage.ENDED:
		_render_status()
	_sync_controls()


func _drop_unknown() -> void:
	var accused: Array[String] = []
	for character_id: String in _accused:
		if _knows_character(character_id):
			accused.append(character_id)
	_accused = accused
	if not _knows_character(_motive_target):
		_motive_target = ""
	var clue_ids: Array[String] = get_clue_ids()
	var evidence: Array[String] = []
	for clue_id: String in _evidence:
		if clue_ids.has(clue_id):
			evidence.append(clue_id)
	_evidence = evidence
	_prune_claims()


func _prune_claims() -> void:
	for part: String in AccusationFormat.PARTS:
		if not _accused.has(str(_subjects[part])):
			_subjects[part] = ""


# --- widgets -----------------------------------------------------------------------------------


func _build_ui() -> void:
	var background: ColorRect = ColorRect.new()
	background.color = Color(0.07, 0.06, 0.07, 1.0)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(background)
	var margin: MarginContainer = MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	for side: String in ["left", "right"]:
		margin.add_theme_constant_override("margin_" + side, 40)
	for side: String in ["top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 32)
	add_child(margin)
	var layout: VBoxContainer = VBoxContainer.new()
	layout.add_theme_constant_override(&"separation", 12)
	margin.add_child(layout)

	var header: HBoxContainer = HBoxContainer.new()
	header.add_theme_constant_override(&"separation", 16)
	layout.add_child(header)
	_back = Button.new()
	_back.name = "Back"
	_back.text = BACK_TEXT
	_back.visible = not _text(_params.get(PARAM_BACK)).is_empty()
	_back.pressed.connect(_on_back_pressed)
	header.add_child(_back)
	var title: Label = Label.new()
	title.text = TITLE_TEXT
	title.add_theme_font_size_override(&"font_size", 40)
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(title)

	_status = _label(layout, "")
	_status.name = "Status"
	_error = _label(layout, "")
	_error.name = "Error"
	_error.add_theme_color_override(&"font_color", Color(1.0, 0.45, 0.4, 1.0))

	var scroll: ScrollContainer = ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	layout.add_child(scroll)
	var content: VBoxContainer = VBoxContainer.new()
	content.name = "Content"
	content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	content.add_theme_constant_override(&"separation", 10)
	scroll.add_child(content)
	_content = content

	_heading(content, ACCUSED_TITLE)
	_accused_box = VBoxContainer.new()
	_accused_box.name = "Accused"
	content.add_child(_accused_box)

	_heading(content, CLAIMS_TITLE)
	_claims_box = GridContainer.new()
	_claims_box.name = "Claims"
	_claims_box.columns = 4
	_claims_box.add_theme_constant_override(&"h_separation", 12)
	content.add_child(_claims_box)
	for part: String in AccusationFormat.PARTS:
		var caption: String = {"motive": MOTIVE_SUBJECT_TEXT, "means": MEANS_TEXT, "opportunity": OPPORTUNITY_TEXT}[part]
		_label(_claims_box, caption)
		var subject: OptionButton = OptionButton.new()
		subject.name = "Subject_" + part
		subject.custom_minimum_size = Vector2(280, 0)
		subject.item_selected.connect(_on_subject_selected.bind(part))
		_claims_box.add_child(subject)
		_subject_options[part] = subject
		if part == "motive":
			_label(_claims_box, MOTIVE_TARGET_TEXT)
			_target_option = OptionButton.new()
			_target_option.name = "MotiveTarget"
			_target_option.custom_minimum_size = Vector2(280, 0)
			_target_option.item_selected.connect(_on_target_selected)
			_claims_box.add_child(_target_option)
		else:
			_claims_box.add_child(Control.new())
			_claims_box.add_child(Control.new())

	_heading(content, EVIDENCE_TITLE)
	_evidence_box = VBoxContainer.new()
	_evidence_box.name = "Evidence"
	content.add_child(_evidence_box)

	_accuse = Button.new()
	_accuse.name = "Accuse"
	_accuse.text = ACCUSE_TEXT
	_accuse.custom_minimum_size = Vector2(260, 48)
	_accuse.size_flags_horizontal = Control.SIZE_SHRINK_END
	_accuse.pressed.connect(func() -> void: request_accusation())
	layout.add_child(_accuse)

	_first_confirm = _dialog("FirstConfirm", FIRST_CONFIRM_TITLE, _on_first_confirmed)
	_final_confirm = _dialog("FinalConfirm", FINAL_CONFIRM_TITLE, _on_final_confirmed)


func _dialog(node_name: String, title: String, on_confirmed: Callable) -> ConfirmationDialog:
	var dialog: ConfirmationDialog = ConfirmationDialog.new()
	dialog.name = node_name
	dialog.title = title
	dialog.ok_button_text = "Да"
	dialog.cancel_button_text = "Отмена"
	dialog.confirmed.connect(on_confirmed)
	dialog.canceled.connect(_on_confirm_canceled)
	add_child(dialog)
	return dialog


## Rebuilds the character and clue lists (only when the view names other characters or clues).
func _rebuild() -> void:
	_clear(_accused_box)
	_clear(_evidence_box)
	if _characters.is_empty():
		_label(_accused_box, NO_CHARACTERS_TEXT).modulate.a = 0.6
	for character: Dictionary in _characters:
		var box: CheckBox = CheckBox.new()
		box.text = str(character["name"])
		box.set_meta(META_ID, str(character["id"]))
		box.toggled.connect(_on_accused_toggled.bind(str(character["id"])))
		_accused_box.add_child(box)
	if _clues.is_empty():
		_label(_evidence_box, NO_CLUES_TEXT).modulate.a = 0.6
	for clue: Dictionary in _clues:
		var box: CheckBox = CheckBox.new()
		var description: String = _text(clue.get("description"))
		box.text = _text(clue.get("title")) if not _text(clue.get("title")).is_empty() else str(clue.get("id"))
		box.tooltip_text = description
		box.set_meta(META_ID, str(clue.get("id")))
		box.toggled.connect(_on_evidence_toggled.bind(str(clue.get("id"))))
		_evidence_box.add_child(box)
	_sync_controls()


## Puts the choice into the widgets and locks them unless the player may edit.
func _sync_controls() -> void:
	if _accuse == null:
		return
	var editable: bool = _editable() and not is_preview() and not _view.is_empty()
	for child: Node in _accused_box.get_children():
		if child is CheckBox:
			var box: CheckBox = child
			box.set_pressed_no_signal(_accused.has(str(box.get_meta(META_ID))))
			box.disabled = not editable
	for child: Node in _evidence_box.get_children():
		if child is CheckBox:
			var box: CheckBox = child
			box.set_pressed_no_signal(_evidence.has(str(box.get_meta(META_ID))))
			box.disabled = not editable
	for part: String in AccusationFormat.PARTS:
		var option: OptionButton = _subject_options[part]
		_fill_option(option, _accused, str(_subjects[part]))
		option.disabled = not editable or _accused.is_empty()
	var everyone: Array[String] = []
	for character: Dictionary in _characters:
		everyone.append(str(character["id"]))
	_fill_option(_target_option, everyone, _motive_target)
	_target_option.disabled = not editable or str(_subjects["motive"]).is_empty()
	_accuse.disabled = not editable or _accused.is_empty()
	_back.disabled = _in_flight()


func _fill_option(option: OptionButton, ids: Array[String], selected: String) -> void:
	option.clear()
	option.add_item(NONE_TEXT)
	option.set_item_metadata(0, "")
	for character_id: String in ids:
		option.add_item(_name_of(character_id))
		option.set_item_metadata(option.item_count - 1, character_id)
	for index: int in option.item_count:
		if str(option.get_item_metadata(index)) == selected:
			option.select(index)
			return
	option.select(0)


func _on_accused_toggled(pressed: bool, character_id: String) -> void:
	var ids: Array[String] = _accused.duplicate()
	if pressed and not ids.has(character_id):
		ids.append(character_id)
	elif not pressed:
		ids.erase(character_id)
	set_accused(ids)


func _on_evidence_toggled(pressed: bool, clue_id: String) -> void:
	var ids: Array[String] = _evidence.duplicate()
	if pressed and not ids.has(clue_id):
		ids.append(clue_id)
	elif not pressed:
		ids.erase(clue_id)
	set_evidence(ids)


func _on_subject_selected(index: int, part: String) -> void:
	var option: OptionButton = _subject_options[part]
	set_claim(part, str(option.get_item_metadata(index)), _motive_target)


func _on_target_selected(index: int) -> void:
	set_claim("motive", str(_subjects["motive"]), str(_target_option.get_item_metadata(index)))


# --- text --------------------------------------------------------------------------------------


func _first_confirm_text(file: Dictionary) -> String:
	var lines: PackedStringArray = PackedStringArray()
	var motive_subject: String = str(_subjects["motive"])
	lines.append(CLAIM_LINE_TEXT % [
		"Мотив",
		NOT_SET_TEXT if motive_subject.is_empty() else "%s против %s" % [_name_of(motive_subject), _name_of(_motive_target)],
	])
	for part: String in ["means", "opportunity"]:
		var subject: String = str(_subjects[part])
		lines.append(CLAIM_LINE_TEXT % [
			str(AccusationFormat.PART_TEXT[part]).capitalize(),
			NOT_SET_TEXT if subject.is_empty() else _name_of(subject),
		])
	var missing: Array[String] = AccusationFormat.missing_parts(file)
	var evidence: Array = file.get("evidence", [])
	return FIRST_CONFIRM_TEXT % [
		_accused_names(file),
		"\n".join(lines),
		evidence.size(),
		(MISSING_TEXT % ", ".join(missing)) if not missing.is_empty() else "",
	]


func _accused_names(file: Dictionary) -> String:
	var names: PackedStringArray = PackedStringArray()
	for character_id: Variant in file.get("accusedIds", []):
		names.append(_name_of(str(character_id)))
	return ", ".join(names)


func _name_of(character_id: String) -> String:
	return str(_names.get(character_id, AccusationFormat.UNKNOWN_CHARACTER_TEXT))


# --- helpers -----------------------------------------------------------------------------------


func _editable() -> bool:
	return _stage == Stage.EDITING


func _in_flight() -> bool:
	return _stage == Stage.PROBING or _stage == Stage.SUBMITTING or _stage == Stage.AWAITING_VIEW


func _knows_character(character_id: String) -> bool:
	for character: Dictionary in _characters:
		if str(character["id"]) == character_id:
			return true
	return false


static func _clue_signature(clue: Dictionary) -> Array:
	return [clue.get("id"), clue.get("title")]


static func _heading(container: Container, text: String) -> void:
	var label: Label = _label(container, text)
	label.add_theme_font_size_override(&"font_size", 24)


static func _label(container: Container, text: String) -> Label:
	var label: Label = Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	container.add_child(label)
	return label


static func _clear(container: Container) -> void:
	for child: Node in container.get_children():
		# Plain widgets with no callback running; freed now so no orphan outlives a rebuild.
		container.remove_child(child)
		child.free()


static func _text(value: Variant) -> String:
	if value is String:
		var text: String = value
		return text
	return ""
