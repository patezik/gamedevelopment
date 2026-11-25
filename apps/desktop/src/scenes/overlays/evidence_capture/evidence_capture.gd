extends Control
## Shows the current pendingCapture from GameStore and fetches its image via Backend.

const Store = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const Envelope = preload("res://src/net/envelope.gd")
const HudFormat = preload("res://src/scenes/hud/hud_format.gd")
const QrTexture = preload("res://src/scenes/overlays/evidence_capture/qr_texture.gd")

const EXPIRED: String = "Срок действия QR истёк. Осмотрите улику ещё раз."
const LOAD_FAILED: String = "Не удалось загрузить QR-код."

var _store: Store
var _backend: BackendScript
var _token_id: String = ""
var _minutes: int = 0
var _request_id: int = -1
var _previous_focus: Control

@onready var _modal: Control = %Modal
@onready var _title: Label = %ClueTitle
@onready var _expires: Label = %Expires
@onready var _status: Label = %Status
@onready var _phone_hint: Label = %PhoneHint
@onready var _qr: TextureRect = %Qr
@onready var _retry: Button = %Retry
@onready var _cancel: Button = %Cancel
@onready var _reopen: Button = %Reopen


## Uses the given sources on entry. A scene with no override uses the project autoloads.
func bind_sources(store: Store, backend: BackendScript) -> void:
	_store = store
	_backend = backend


func _ready() -> void:
	if _store == null:
		_store = get_node("/root/GameStore") as Store
	if _backend == null:
		_backend = get_node("/root/Backend") as BackendScript
	_store.view_changed.connect(_on_view_changed)
	_store.peer_status_changed.connect(_on_peer_status)
	_store.connection_state_changed.connect(_on_connection_state)
	_backend.rest_completed.connect(_on_rest_completed)
	_cancel.pressed.connect(_cancel_capture)
	_retry.pressed.connect(_load_qr)
	_reopen.pressed.connect(_open_capture)
	_on_view_changed(_store.get_view(), _store.get_state_version())


func _shortcut_input(event: InputEvent) -> void:
	if _modal.is_visible_in_tree() and event.is_action_pressed("ui_cancel"):
		_cancel_capture()
		get_viewport().set_input_as_handled()


func _exit_tree() -> void:
	_cancel_request()


func _on_view_changed(view: Dictionary, _version: int) -> void:
	var pending: Dictionary = HudFormat.read_dict(view, "pendingCapture")
	var token_id: String = HudFormat.read_string(pending, "tokenId")
	if token_id.is_empty():
		_clear_capture()
		return

	var old_minutes: int = _minutes
	_minutes = Envelope.counter(pending.get("expiresInMinutes"))
	_title.text = HudFormat.read_string(pending, "clueTitle")
	_expires.text = "Осталось %d игровых мин." % maxi(_minutes, 0)
	_on_peer_status("", _store.get_phone_status())
	if token_id != _token_id:
		_token_id = token_id
		_open_capture()
	elif _modal.visible:
		if _minutes <= 0:
			_show_status(EXPIRED)
		elif old_minutes <= 0:
			_load_qr()


func _on_peer_status(_desktop: String, phone: String) -> void:
	var state: String = HudFormat.phone_state(phone, HudFormat.read_dict(_store.get_view(), "phone"))
	_phone_hint.visible = state == HudFormat.PHONE_OFFLINE or state == HudFormat.PHONE_UNPAIRED
	if state == HudFormat.PHONE_UNPAIRED:
		_phone_hint.text = "Телефон не привязан. Подключите его к игровой сессии."
	else:
		_phone_hint.text = "Телефон не в сети. Восстановите его подключение к игре."


func _on_connection_state(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.OFFLINE:
		_clear_capture()


func _open_capture() -> void:
	if not _modal.visible:
		_previous_focus = get_viewport().gui_get_focus_owner()
	_reopen.hide()
	_modal.show()
	_cancel.grab_focus()
	_load_qr()


func _cancel_capture() -> void:
	_clear_image()
	_modal.hide()
	_reopen.show()
	_restore_focus()


func _clear_capture() -> void:
	_token_id = ""
	_minutes = 0
	_clear_image()
	_modal.hide()
	_reopen.hide()
	_restore_focus()


func _restore_focus() -> void:
	if is_instance_valid(_previous_focus) and _previous_focus.is_visible_in_tree():
		_previous_focus.grab_focus()
	elif _reopen.visible:
		_reopen.grab_focus()
	_previous_focus = null


func _clear_image() -> void:
	_cancel_request()
	_qr.texture = null
	_qr.hide()


func _cancel_request() -> void:
	if _request_id >= 0:
		var previous: int = _request_id
		_request_id = -1
		if is_instance_valid(_backend):
			_backend.cancel_queued_rest(previous)


func _show_status(message: String, can_retry: bool = false) -> void:
	_clear_image()
	_status.text = message
	if not can_retry and _retry.has_focus():
		_cancel.grab_focus()
	_retry.visible = can_retry
	# Keep keyboard focus inside the modal, including when retry is available.
	var neighbor: NodePath = _cancel.get_path_to(_retry) if can_retry else NodePath(".")
	_cancel.focus_next = neighbor
	_cancel.focus_previous = neighbor
	_cancel.focus_neighbor_left = neighbor
	_cancel.focus_neighbor_right = neighbor


func _load_qr() -> void:
	if _minutes <= 0:
		_show_status(EXPIRED)
		return
	_show_status("Загрузка QR-кода…")
	_request_id = _backend.request_evidence_qr(_token_id)
	if _request_id < 0:
		_show_status(LOAD_FAILED, true)


func _on_rest_completed(request_id: int, result: int, status: int, body: Variant) -> void:
	if request_id != _request_id:
		return
	_request_id = -1
	if result != HTTPRequest.RESULT_SUCCESS:
		_show_status(LOAD_FAILED, true)
		return
	match status:
		200:
			var texture: ImageTexture = QrTexture.from_response(body)
			if texture == null:
				_show_status(LOAD_FAILED, true)
				return
			_qr.texture = texture
			_qr.show()
			_status.text = "Откройте камеру игрового телефона и наведите её на QR-код."
		409:
			_show_status("Улика уже зафиксирована. Ожидаем обновления дела.")
		410:
			_show_status(EXPIRED)
		_:
			_show_status(LOAD_FAILED, true)
