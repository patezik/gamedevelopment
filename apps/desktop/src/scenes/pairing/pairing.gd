extends Control
## Pairing: the phone joins the session NewGame created (godot-client.md §4.7, protocol.md §7).
##
## Shows the pairing QR from the server matrix (`GET /sessions/:id/pairing-qr`, drawn by QrTexture
## with nearest filtering), the code as text, the server address with the LAN candidates of
## `GET /network`, the desktop connection and the phone status of `peer.status`. An expired code
## is replaced once through `POST /sessions/:id/pairing-code`; the player can ask for a new one.
## «Начать расследование» is enabled only while the server confirms, over this session's live
## connection, that the phone is online.

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const Format = preload("res://src/scenes/pairing/pairing_format.gd")
const QrTexture = preload("res://src/scenes/overlays/evidence_capture/qr_texture.gd")

const START_SCREEN: StringName = &"exploration"
const BACK_SCREEN: StringName = &"new_game"
## Upper bound of the QR side on the 1920×1080 canvas.
const QR_MAX_SIDE: int = 520
const TICK_SECONDS: float = 0.5

const TITLE_TEXT: String = "Подключение телефона"
const STEPS_TEXT: String = "Откройте Hollow Signal на телефоне и на экране привязки наведите камеру на QR-код. Можно ввести адрес и код вручную."
const CODE_CAPTION: String = "Код привязки"
const ADDRESS_CAPTION: String = "Адрес сервера"
const ADDRESS_OTHER_HINT: String = "В QR-коде адрес %s. Для выбранного адреса введите адрес и код на телефоне вручную."
const LOCAL_ONLY_HINT: String = "Сервер выдал локальный адрес %s: телефон по нему не подключится. Выберите адрес сети и введите его вручную или задайте HS_PUBLIC_HOST."
const QR_LOADING: String = "Загрузка QR-кода…"
const QR_REFRESHING: String = "Получаем новый код…"
const QR_SHOWN_TEXT: String = "Наведите камеру телефона на QR-код."
const QR_UNAVAILABLE_TEXT: String = "Сервер не выдал QR-код. Введите адрес и код на телефоне вручную."
const QR_NO_CODE_TEXT: String = "Код больше не действует: возможно, телефон уже привязан. Нажмите «Новый код», чтобы привязать телефон."
const QR_EXPIRED_TEXT: String = "Срок действия кода истёк. Нажмите «Новый код»."
const QR_NETWORK_TEXT: String = "Сервер не ответил. Повторите попытку."
const QR_FAILED_TEXT: String = "Не удалось получить QR-код."
const SESSION_LOST_TEXT: String = "Сервер больше не знает эту сессию. Вернитесь и создайте новую игру."
const NO_SESSION_TEXT: String = "Сессия не создана. Вернитесь к созданию игры."
const SESSION_CHANGED_TEXT: String = "Игра подключена к другой сессии. Вернитесь и создайте игру заново."
const PAIRED_TEXT: String = "Телефон привязан к этой игре."
const REJECTED_TEXT: String = "Сервер отклонил подключение игры (%s)."
const START_TEXT: String = "Начать расследование"
const START_WAIT_TEXT: String = "Кнопка станет доступна, когда сервер подтвердит, что телефон в сети."
const NEW_CODE_TEXT: String = "Новый код"
const RETRY_TEXT: String = "Повторить"
const RECONNECT_TEXT: String = "Переподключить игру"
const BACK_TEXT: String = "Назад"
const ERROR_COLOR: Color = Color(1.0, 0.45, 0.4, 1.0)
const OK_COLOR: Color = Color(0.55, 0.85, 0.6, 1.0)

## Wall clock in Unix milliseconds, the clock of the server's `expiresAt`; tests replace it.
var clock: Callable = func() -> int: return int(Time.get_unix_time_from_system() * 1000.0)

var _backend: BackendScript
var _store: GameStoreScript
var _router: Node
var _session: PairingSession
var _qr_request: int = -1
var _code_request: int = -1
var _network_request: int = -1
## Outcome of the last QR or code request (Format.QR_*), or "loading"/"refreshing".
var _qr_state: String = ""
## The current code is replaced automatically once [member clock] passes its expiry: it was valid
## by that clock when it arrived and has not been replaced yet.
var _auto_refresh_armed: bool = false
## A «code expired» QR answer already replaced the code and no QR has been shown since. A server
## that keeps answering so (its clock ahead of ours) then leaves the next code to the player.
var _replaced_on_expiry: bool = false
var _options: Array[Dictionary] = []
var _rejection: String = ""

var _qr: TextureRect
var _qr_status: Label
var _code: Label
var _expiry: Label
var _address: Label
var _address_choice: OptionButton
var _address_hint: Label
var _connection: Label
var _phone: Label
var _error: Label
var _new_code: Button
var _retry: Button
var _reconnect: Button
var _start: Button
var _start_hint: Label
var _back: Button
var _pairing_box: Control
var _code_box: Control
var _timer: Timer


## Uses these sources instead of the Backend, GameStore and SceneRouter autoloads.
## Call before the node enters the tree.
func bind_sources(backend: BackendScript, store: GameStoreScript, router: Node) -> void:
	_backend = backend
	_store = store
	_router = router


func _ready() -> void:
	if _backend == null:
		_backend = get_node(^"/root/Backend") as BackendScript
	if _store == null:
		_store = get_node(^"/root/GameStore") as GameStoreScript
	if _router == null:
		_router = get_node_or_null(^"/root/SceneRouter")
	_session = PairingSession.current()
	_build_ui()
	_backend.rest_completed.connect(_on_rest_completed)
	_store.peer_status_changed.connect(func(_desktop: String, _phone: String) -> void: _refresh())
	_store.connection_state_changed.connect(_on_connection_state)
	_store.error_received.connect(_on_error_received)
	if _session == null:
		_error.text = NO_SESSION_TEXT
		_refresh()
		return
	_arm_auto_refresh()
	_options = Format.address_options(_session.qr_host, null)
	_fill_addresses()
	_network_request = _backend.request_rest(_session.origin + "/api/v1/network")
	_request_qr()
	_timer.start()


func _exit_tree() -> void:
	for request_id: int in [_qr_request, _code_request, _network_request]:
		if request_id >= 0 and is_instance_valid(_backend):
			_backend.cancel_queued_rest(request_id)
	_qr_request = -1
	_code_request = -1
	_network_request = -1


## The player asks for a new pairing code (the previous one stops working) and then its QR.
func request_new_code() -> void:
	_replaced_on_expiry = false
	_request_code()


func _request_code() -> void:
	if not _is_current() or _code_request >= 0:
		return
	if _qr_request >= 0:
		_backend.cancel_queued_rest(_qr_request)
		_qr_request = -1
	_set_qr(null)
	_qr_state = "refreshing"
	_code_request = _backend.request_rest(
		_session.endpoint("pairing-code"), HTTPClient.METHOD_POST, "", _session.desktop_token()
	)
	_refresh()


## Opens «Начать расследование» if the server confirmed an online phone. Returns the router error,
## or ERR_UNAVAILABLE while the button is disabled.
func start_investigation() -> Error:
	if not _can_start() or _router == null:
		return ERR_UNAVAILABLE
	return _router.call(&"goto", START_SCREEN) as Error


## Leaves the session: the desktop connection closes, the session is forgotten and NewGame opens.
func go_back() -> void:
	_exit_tree()
	if _session != null and PairingSession.current() == _session:
		_backend.disconnect_session()
		PairingSession.clear()
		var overlay: Node = get_tree().root.get_node_or_null(^"DebugOverlay")
		if overlay != null and overlay.has_method(&"detach_session"):
			overlay.call(&"detach_session")
	if _router != null:
		_router.call(&"goto", BACK_SCREEN)


## Checks the code expiry; called by the screen timer, and by tests after moving [member clock].
func tick() -> void:
	if not _is_current():
		_refresh()
		return
	var expired: bool = _session.expires_at <= _now()
	if expired and _auto_refresh_armed and _code_request < 0 and not _phone_paired():
		_auto_refresh_armed = false
		_request_code()
		return
	_refresh()


func get_qr_state() -> String:
	return _qr_state


func _request_qr() -> void:
	if _qr_request >= 0:
		_backend.cancel_queued_rest(_qr_request)
	_set_qr(null)
	_qr_state = "loading"
	_qr_request = _backend.request_rest(
		_session.endpoint("pairing-qr"), HTTPClient.METHOD_GET, "", _session.desktop_token()
	)
	_refresh()


func _now() -> int:
	return clock.call() as int


func _arm_auto_refresh() -> void:
	_auto_refresh_armed = _session.expires_at > _now()


func _on_rest_completed(request_id: int, result: int, status: int, body: Variant) -> void:
	if request_id < 0 or not _is_current():
		return
	if request_id == _qr_request:
		_qr_request = -1
		_on_qr(result, status, body)
	elif request_id == _code_request:
		_code_request = -1
		_on_code(result, status, body)
	elif request_id == _network_request:
		_network_request = -1
		if result == HTTPRequest.RESULT_SUCCESS and status == 200:
			_options = Format.address_options(_session.qr_host, body)
			_fill_addresses()
		_refresh()


func _on_qr(result: int, status: int, body: Variant) -> void:
	_qr_state = Format.classify(result, status, body)
	if _qr_state == Format.QR_SHOWN:
		var texture: ImageTexture = QrTexture.from_response(body)
		if texture == null:
			_qr_state = Format.QR_FAILED
		else:
			_replaced_on_expiry = false
		_set_qr(texture)
	elif _qr_state == Format.QR_EXPIRED and not _replaced_on_expiry and not _phone_paired():
		_replaced_on_expiry = true
		_auto_refresh_armed = false
		_request_code()
		return
	_refresh()


func _on_code(result: int, status: int, body: Variant) -> void:
	var outcome: String = Format.classify(result, status, body)
	var pairing: Dictionary = {}
	if outcome == Format.QR_SHOWN:
		pairing = PairingSession.parse_pairing(body)
		if pairing.is_empty():
			outcome = Format.QR_FAILED
	if outcome != Format.QR_SHOWN:
		_qr_state = outcome
		_refresh()
		return
	_session.apply_pairing(pairing)
	_arm_auto_refresh()
	_options = Format.address_options(_session.qr_host, null)
	_network_request = _backend.request_rest(_session.origin + "/api/v1/network")
	_fill_addresses()
	_request_qr()


func _on_connection_state(state: BackendScript.ConnectionState) -> void:
	if state != BackendScript.ConnectionState.OFFLINE:
		_rejection = ""
	_refresh()


func _on_error_received(code: String, _message: String) -> void:
	if _store.get_connection_state() == BackendScript.ConnectionState.OFFLINE:
		_rejection = code
	_refresh()


func _reconnect_game() -> void:
	if _is_current():
		_rejection = ""
		_backend.connect_session(_session.ws_url(), _session.desktop_token())
		_refresh()


func _is_current() -> bool:
	return _session != null and PairingSession.current() == _session


func _phone_paired() -> bool:
	return _connected_here() and Format.is_paired(_store.get_phone_status())


## The Backend is in this session (or has not received a `welcome` yet).
func _connected_here() -> bool:
	var connected: String = _store.get_session_id()
	return _session != null and (connected.is_empty() or connected == _session.session_id)


func _can_start() -> bool:
	return _is_current() and Format.can_start(
		_store.get_connection_state(), _store.get_session_id(), _session.session_id,
		_store.get_phone_status()
	)


func _set_qr(texture: ImageTexture) -> void:
	_qr.texture = texture
	var side: int = Format.qr_display_side(texture.get_width(), QR_MAX_SIDE) if texture != null else 0
	_qr.custom_minimum_size = Vector2(side, side)
	_qr.visible = texture != null


func _fill_addresses() -> void:
	_address_choice.clear()
	for index: int in range(_options.size()):
		_address_choice.add_item(Format.address_label(_options[index], _session.qr_port), index)
	_address_choice.select(0)
	_address_choice.visible = _options.size() > 1


func _refresh() -> void:
	var current: bool = _is_current()
	var here: bool = current and _connected_here()
	var paired: bool = here and Format.is_paired(_store.get_phone_status())
	_back.disabled = false

	if _session == null:
		_error.text = NO_SESSION_TEXT
	elif not current or not here:
		_error.text = SESSION_CHANGED_TEXT
	elif _qr_state == Format.QR_SESSION_LOST:
		_error.text = SESSION_LOST_TEXT
	elif not _rejection.is_empty():
		_error.text = REJECTED_TEXT % _rejection
	else:
		_error.text = ""

	var live: bool = current and here and _qr_state != Format.QR_SESSION_LOST
	_pairing_box.visible = live
	if live:
		_code.text = _session.code
		_expiry.text = Format.expiry_text(_session.expires_at, _now())
		_qr_status.text = PAIRED_TEXT if paired else _qr_text()
		if paired:
			_qr_status.add_theme_color_override(&"font_color", OK_COLOR)
		else:
			_qr_status.remove_theme_color_override(&"font_color")
		_qr.visible = _qr.texture != null and not paired
		_code_box.visible = not paired
		_refresh_address_hint()

	var state: BackendScript.ConnectionState = _store.get_connection_state()
	if not here:
		state = BackendScript.ConnectionState.OFFLINE
	_connection.text = Format.connection_text(state)
	_phone.text = Format.phone_text(_store.get_phone_status() if here else "")
	_reconnect.visible = live and state == BackendScript.ConnectionState.OFFLINE
	_new_code.visible = live and _qr_state != "refreshing"
	_new_code.disabled = _code_request >= 0
	_retry.visible = live and not paired and (_qr_state == Format.QR_NETWORK or _qr_state == Format.QR_FAILED)
	_retry.disabled = _qr_request >= 0
	var can_start: bool = _can_start()
	_start.disabled = not can_start
	_start_hint.visible = not can_start


func _qr_text() -> String:
	match _qr_state:
		"loading":
			return QR_LOADING
		"refreshing":
			return QR_REFRESHING
		Format.QR_SHOWN:
			return QR_SHOWN_TEXT
		Format.QR_UNAVAILABLE:
			return QR_UNAVAILABLE_TEXT
		Format.QR_NO_CODE:
			return QR_NO_CODE_TEXT
		Format.QR_EXPIRED:
			return QR_EXPIRED_TEXT
		Format.QR_NETWORK:
			return QR_NETWORK_TEXT
		_:
			return QR_FAILED_TEXT


func _refresh_address_hint() -> void:
	var index: int = maxi(_address_choice.selected, 0)
	var option: Dictionary = _options[index] if index < _options.size() else {}
	var address: String = str(option.get("address", _session.qr_host))
	_address.text = "%s:%d" % [address, _session.qr_port]
	if option.get("in_qr", true) == true:
		_address_hint.text = LOCAL_ONLY_HINT % _session.qr_host if Format.is_local_only(_session.qr_host) else ""
	else:
		_address_hint.text = ADDRESS_OTHER_HINT % ("%s:%d" % [_session.qr_host, _session.qr_port])
	_address_hint.visible = not _address_hint.text.is_empty()


# --- widgets -----------------------------------------------------------------------------------


func _build_ui() -> void:
	_timer = Timer.new()
	_timer.wait_time = TICK_SECONDS
	_timer.timeout.connect(tick)
	add_child(_timer)

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
	layout.add_theme_constant_override(&"separation", 14)
	margin.add_child(layout)

	var header: HBoxContainer = HBoxContainer.new()
	header.add_theme_constant_override(&"separation", 16)
	layout.add_child(header)
	_back = Button.new()
	_back.name = "Back"
	_back.text = BACK_TEXT
	_back.pressed.connect(go_back)
	header.add_child(_back)
	var title: Label = Label.new()
	title.text = TITLE_TEXT
	title.add_theme_font_size_override(&"font_size", 40)
	header.add_child(title)
	_error = _label(layout, "")
	_error.name = "Error"
	_error.add_theme_color_override(&"font_color", ERROR_COLOR)

	var body: HBoxContainer = HBoxContainer.new()
	body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.add_theme_constant_override(&"separation", 48)
	layout.add_child(body)
	_pairing_box = body

	var qr_column: VBoxContainer = VBoxContainer.new()
	qr_column.custom_minimum_size = Vector2(QR_MAX_SIDE, 0)
	qr_column.add_theme_constant_override(&"separation", 12)
	body.add_child(qr_column)
	_qr = TextureRect.new()
	_qr.name = "Qr"
	# One server module is a block of equal screen pixels: no filtering, no fractional scale.
	_qr.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_qr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_qr.stretch_mode = TextureRect.STRETCH_SCALE
	_qr.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	_qr.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_qr.visible = false
	qr_column.add_child(_qr)
	_qr_status = _label(qr_column, "")
	_qr_status.name = "QrStatus"
	_qr_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER

	var info: VBoxContainer = VBoxContainer.new()
	info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	info.add_theme_constant_override(&"separation", 12)
	body.add_child(info)
	_label(info, STEPS_TEXT)
	var code_box: VBoxContainer = VBoxContainer.new()
	info.add_child(code_box)
	_code_box = code_box
	_caption(code_box, CODE_CAPTION)
	_code = _label(code_box, "")
	_code.name = "Code"
	_code.add_theme_font_size_override(&"font_size", 72)
	_expiry = _label(code_box, "")
	_expiry.name = "Expiry"
	_caption(code_box, ADDRESS_CAPTION)
	_address = _label(code_box, "")
	_address.name = "Address"
	_address.add_theme_font_size_override(&"font_size", 36)
	_address_choice = OptionButton.new()
	_address_choice.name = "AddressChoice"
	_address_choice.visible = false
	_address_choice.item_selected.connect(func(_index: int) -> void: _refresh())
	code_box.add_child(_address_choice)
	_address_hint = _label(code_box, "")
	_address_hint.name = "AddressHint"
	_address_hint.modulate.a = 0.8

	var actions: HBoxContainer = HBoxContainer.new()
	actions.add_theme_constant_override(&"separation", 12)
	info.add_child(actions)
	_new_code = _button(actions, "NewCode", NEW_CODE_TEXT, request_new_code)
	_retry = _button(actions, "Retry", RETRY_TEXT, _request_qr)

	_caption(info, "Статус")
	_connection = _label(info, "")
	_connection.name = "Connection"
	_phone = _label(info, "")
	_phone.name = "Phone"
	_phone.add_theme_font_size_override(&"font_size", 28)
	_reconnect = _button(info, "Reconnect", RECONNECT_TEXT, _reconnect_game)
	_reconnect.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN

	var footer: VBoxContainer = VBoxContainer.new()
	layout.add_child(footer)
	_start = _button(footer, "Start", START_TEXT, func() -> void: start_investigation())
	_start.size_flags_horizontal = Control.SIZE_SHRINK_END
	_start.add_theme_font_size_override(&"font_size", 28)
	_start_hint = _label(footer, START_WAIT_TEXT)
	_start_hint.name = "StartHint"
	_start_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_start_hint.modulate.a = 0.7


static func _label(container: Container, text: String) -> Label:
	var label: Label = Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	container.add_child(label)
	return label


static func _caption(container: Container, text: String) -> void:
	var label: Label = _label(container, text)
	label.add_theme_font_size_override(&"font_size", 22)
	label.modulate.a = 0.7


static func _button(container: Container, node_name: String, text: String, action: Callable) -> Button:
	var button: Button = Button.new()
	button.name = node_name
	button.text = text
	button.pressed.connect(action)
	container.add_child(button)
	return button
