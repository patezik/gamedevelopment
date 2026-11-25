extends Control
## Renders the active PlayerView interaction and sends its choices through GameStore.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const CostFormat = preload("res://src/ui/cost_format.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")

const ERROR_TEXT: Dictionary = {
	ProtocolConstants.ERROR_ACTION_INVALID: "Сервер отклонил действие.",
	ProtocolConstants.ERROR_ACTION_NOT_AVAILABLE: "Это действие сейчас недоступно.",
	ProtocolConstants.ERROR_ACTION_BLOCKED: "Действие заблокировано.",
	ProtocolConstants.ERROR_GAME_OVER: "Игра окончена.",
	ProtocolConstants.ERROR_RATE_LIMITED: "Слишком много запросов, попробуйте позже.",
}

var _store: GameStoreScript
var _params: Dictionary
var _routed: bool = false
var _preview: String = ""
var _partner: String = ""
var _active: bool = false
var _leaving: bool = false
var _lines: Array = []
var _request_id: String = ""
var _accepted: bool = false
var _confirmed_action: Dictionary = {}
var _choices: Array[Button] = []

@onready var _name: Label = %CharacterName
@onready var _back: Button = %Back
@onready var _status: Label = %Status
@onready var _error: Label = %Error
@onready var _content: Control = %Content
@onready var _history: RichTextLabel = %History
@onready var _topics: VBoxContainer = %Topics
@onready var _subjects: VBoxContainer = %Subjects
@onready var _present: Button = %Present
@onready var _confirm: ConfirmationDialog = %Confirm


func set_params(params: Dictionary) -> void:
	_params = params
	_routed = true


func _ready() -> void:
	_back.pressed.connect(_return_to_exploration)
	_present.toggled.connect(_set_subjects_visible)
	_confirm.confirmed.connect(_send_confirmed)
	_confirm.canceled.connect(_clear_confirmation)
	_partner = str(_params.get("characterId", ""))
	_store = get_node_or_null(^"/root/GameStore") as GameStoreScript
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.action_resolved.connect(_on_action_resolved)
		_store.connection_state_changed.connect(_on_connection_state_changed)
	var has_view: bool = _store != null and _store.has_view()
	_preview = str(_params.get("preview", ""))
	if not _routed and not has_view:
		_preview = PreviewFixtures.DEFAULT_NAME
	if not _preview.is_empty():
		_show(PreviewFixtures.load_view(_preview))
	else:
		_show(_store.get_view() if _store != null else {})


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed(&"ui_cancel") and not _back.disabled:
		get_viewport().set_input_as_handled()
		_return_to_exploration()


func _return_to_exploration() -> void:
	if _back.disabled:
		return
	var router: SceneRouterScript = get_node_or_null(^"/root/SceneRouter") as SceneRouterScript
	if router != null:
		var params: Dictionary = {} if _preview.is_empty() else {"preview": _preview}
		_leaving = router.goto(&"exploration", params) == OK
		_update_controls()


func _show(view: Dictionary) -> void:
	var interaction: Dictionary = view.get("interaction", {})
	var character_id: String = interaction.get("characterId", "")
	if _partner.is_empty():
		_partner = character_id
	_active = not character_id.is_empty() and character_id == _partner and not view.has("ending")
	_content.visible = _active
	if not _active:
		_error.hide()
	_name.text = str(interaction.get("characterName", "")) if _active else "Разговор"
	_choices.clear()
	_clear_items(_topics)
	_clear_items(_subjects)
	var lines: Array = interaction.get("history", []) if _active else []
	_update_history(lines)
	if _active:
		var offered: Array = view.get("availableActions", [])
		var topics: Array = interaction.get("topics", [])
		var subjects: Array = interaction.get("presentable", [])
		var case_board: Dictionary = view.get("caseBoard", {})
		_render_topics(topics, offered)
		_render_subjects(subjects, offered, case_board)
	_present.disabled = _subjects.get_child_count() == 0
	_set_subjects_visible(_present.button_pressed)
	_update_controls()


func _render_topics(topics: Array, offered: Array) -> void:
	for topic: Dictionary in topics:
		var action: Dictionary = {
			"type": ProtocolConstants.ACTION_TALK, "characterId": _partner, "topicId": topic["id"],
		}
		_add_choice(
			_topics, str(topic["label"]), action, topic["costPreview"], _offer(offered, action)
		)
	if topics.is_empty():
		var empty: Label = Label.new()
		empty.text = "Нет доступных тем."
		_topics.add_child(empty)


func _render_subjects(items: Array, offered: Array, case_board: Dictionary) -> void:
	var summaries: Dictionary = {}
	var contradictions: Array = case_board.get("contradictions", [])
	for contradiction: Dictionary in contradictions:
		summaries[contradiction["id"]] = contradiction["summary"]
	for item: Dictionary in items:
		var subject_type: String = item["type"]
		var id: String = item["id"]
		var label: String = item["label"]
		var subject: Dictionary
		if subject_type == "evidence":
			subject = {"type": subject_type, "clueId": id}
			label = "Улика · " + label
		elif subject_type == "contradiction":
			subject = {"type": subject_type, "contradictionId": id}
			label = "Противоречие · " + str(summaries.get(id, label))
		else:
			continue
		var action: Dictionary = {
			"type": ProtocolConstants.ACTION_INTERROGATE, "characterId": _partner, "subject": subject,
		}
		var entry: Dictionary = _offer(offered, action)
		_add_choice(_subjects, label, action, entry.get("costPreview"), entry)


func _add_choice(
	container: VBoxContainer, label: String, action: Dictionary, cost: Variant, entry: Dictionary
) -> void:
	var button: Button = Button.new()
	button.text = "%s · %s" % [label, CostFormat.format_cost(cost)]
	button.alignment = HORIZONTAL_ALIGNMENT_LEFT
	button.custom_minimum_size.y = 44.0
	button.add_theme_font_size_override(&"font_size", 22)
	button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var reason: String = str(entry.get("blockedReason", ""))
	if not reason.is_empty():
		button.text += " (%s)" % reason
	button.set_meta(&"blocked", not reason.is_empty())
	if reason.is_empty():
		button.pressed.connect(_on_choice.bind(action, label, cost))
	container.add_child(button)
	_choices.append(button)


func _set_subjects_visible(expanded: bool) -> void:
	_subjects.visible = expanded and _subjects.get_child_count() > 0


func _update_history(lines: Array) -> void:
	if _lines == lines:
		return
	_lines = lines
	_history.clear()
	for line: Dictionary in lines:
		var player: bool = line["speaker"] == "player"
		var speaker: String = "Вы" if player else _name.text
		var text: String = line["text"]
		# ENG-003 can send unresolved template keys; their arguments are server-side.
		if not player and text == "testimony_none":
			text = "Собеседник ничего не сообщил."
		elif not player and text.begins_with("testimony_"):
			text = "Текст показания недоступен."
		_history.push_color(Color(0.67, 0.76, 0.83))
		_history.add_text("%s · мин. %d" % [speaker, line["at"]])
		_history.pop()
		_history.add_text("\n%s\n\n" % text)


func _on_choice(action: Dictionary, label: String, cost: Variant) -> void:
	if not _can_send():
		return
	if CostFormat.is_long(cost):
		_confirmed_action = action
		_confirm.dialog_text = "«%s» · %s. Выполнить?" % [label, CostFormat.format_cost(cost)]
		_confirm.popup_centered()
	else:
		_send(action)


func _clear_confirmation() -> void:
	_confirmed_action = {}
	_confirm.hide()


func _send_confirmed() -> void:
	var action: Dictionary = _confirmed_action
	_clear_confirmation()
	if not action.is_empty() and _can_send():
		_send(action)


func _send(action: Dictionary) -> void:
	_error.text = ""
	_error.hide()
	if _store.request_action(action) != OK:
		_error.text = "Не удалось отправить действие. Проверьте соединение."
		_error.show()
		return
	_request_id = _store.get_last_action_request_id()
	_update_controls()


func _on_view_changed(view: Dictionary, _version: int) -> void:
	if _accepted:
		_clear_request()
	_preview = ""
	_clear_confirmation()
	_show(view)


func _on_action_resolved(request_id: String, ok: bool, code: String, _message: String) -> void:
	if _request_id.is_empty() or request_id != _request_id:
		return
	if ok:
		_accepted = true
		return
	_clear_request()
	_error.text = str(ERROR_TEXT.get(code, "Не удалось выполнить действие."))
	_error.show()
	_update_controls()


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state != BackendScript.ConnectionState.ONLINE:
		_clear_request()
		_clear_confirmation()
		_error.hide()
	if state == BackendScript.ConnectionState.OFFLINE and _preview.is_empty():
		_show({})
	else:
		_update_controls()


func _clear_request() -> void:
	_request_id = ""
	_accepted = false


func _can_send() -> bool:
	return (
		_active and not _leaving and _preview.is_empty() and _request_id.is_empty() and _is_online()
	)


func _is_online() -> bool:
	return _store != null and _store.is_online()


func _update_controls() -> void:
	var can_send: bool = _can_send()
	for button: Button in _choices:
		var blocked: bool = button.get_meta(&"blocked")
		button.disabled = not can_send or blocked
	_back.disabled = _leaving or not _request_id.is_empty()
	_status.text = ""
	if not _preview.is_empty():
		_status.text = "Предпросмотр без сервера."
	elif not _is_online():
		_status.text = "Ожидание соединения с сервером."
	elif not _request_id.is_empty():
		_status.text = "Ожидание ответа сервера…"
	elif not _active:
		_status.text = "Разговор завершён." if _store.has_view() else "Ожидание данных разговора."
	_status.visible = not _status.text.is_empty()


static func _offer(entries: Array, action: Dictionary) -> Dictionary:
	for entry: Dictionary in entries:
		if entry.get("action") == action:
			return entry
	return {}


static func _clear_items(container: Container) -> void:
	for child: Node in container.get_children():
		container.remove_child(child)
		child.queue_free()
