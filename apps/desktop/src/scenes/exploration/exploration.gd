extends Control
## Exploration screen (godot-client.md §4): the current location, its points of interest, the
## characters present, the exits, the actions with their cost and a map of the places seen.
##
## Everything shown comes from the PlayerView in GameStore; actions are only the entries of
## `availableActions` and go out through [method GameStoreScript.request_action] unchanged. The
## screen computes no game rules (ADR 0002): no costs, no reachability, no outcomes. While an
## action is in flight the buttons are locked until the next view or `action_failed`.
##
## Preview mode: run the scene on its own (no SceneRouter params) or route to it with
## `{"preview": "<fixture>"}` to render a PlayerView fixture without a session server. A live view
## from GameStore replaces the preview as soon as it arrives.
##
## Art (art-direction.md §5–§7, GDT-012): the plate of `location.id` in its `location.lighting`
## at ×3 and the portraits of `presentCharacters[].portraitRef` at ×2 in the photo frame, both
## with nearest filtering. Paths come only from those PlayerView fields; without a file the plate
## keeps the colour placeholder and a portrait the shared silhouette. A change of lighting in the
## same location dips the plate to black and back.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const ArtLibrary = preload("res://src/ui/art_library.gd")
const CostFormat = preload("res://src/ui/cost_format.gd")
const KnownMap = preload("res://src/ui/known_map.gd")
const LocationMap = preload("res://src/ui/location_map.gd")
const PortraitFrame = preload("res://src/ui/portrait_frame.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

## Route param naming the PlayerView fixture to preview.
const PARAM_PREVIEW: String = "preview"
## Route param with the scenario id of the session, whose art is shown (default: the MVP one).
const PARAM_SCENARIO: String = "scenario"
## Metadata of action buttons: the PlayerAction they send and whether the view blocked them.
const META_ACTION: StringName = &"action"
const META_BLOCKED: StringName = &"blocked"

const UNTITLED_TEXT: String = "Без названия"
const NO_VIEW_TEXT: String = "Нет данных о локации: ожидание состояния от сервера."
const DIALOGUE_WAIT_TEXT: String = "Ожидание ответа собеседника…"
const PREVIEW_TEXT: String = "Предпросмотр без сервера: фикстура %s"
const PREVIEW_FAILED_TEXT: String = "Предпросмотр недоступен: фикстура «%s» не загружена."
const NO_HOTSPOTS_TEXT: String = "Ничего примечательного."
const NO_CHARACTERS_TEXT: String = "Никого нет."
const NO_EXITS_TEXT: String = "Выходов не видно."
const NO_ACTIONS_TEXT: String = "Нет доступных действий."
const NO_MAP_TEXT: String = "Карта пуста."
const EXAMINED_SUFFIX: String = " (осмотрено)"
const GO_TEXT: String = "Перейти"
const EXIT_UNAVAILABLE_TEXT: String = "недоступно"
const CONFIRM_TEXT: String = "«%s» займёт %s игрового времени. Выполнить?"
const LIGHTING_TEXT: Dictionary = {
	"bright": "Светло",
	"dim": "Полумрак",
	"dark": "Темно",
}
const LIGHTING_VALUE: Dictionary = {
	"bright": 0.42,
	"dim": 0.28,
	"dark": 0.14,
}
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
var _known_map: KnownMap = KnownMap.new()
var _pending: bool = false
var _dialogue_target: String = ""
var _dialogue_request_id: String = ""
var _dialogue_accepted: bool = false
var _opening_dialogue: bool = false
var _dialogue_error: bool = false
var _confirm_action: Dictionary = {}
var _action_buttons: Array[Button] = []
var _art: ArtLibrary = null
var _plate_location: String = ""
var _plate_lighting: String = ""
var _plate_path: String = ""
var _plate_tween: Tween = null
var _plate_swap_pending: bool = false
var _portrait_frames: Dictionary = {}
## Half of the dip to black when the lighting of the location changes (tests shorten it).
var plate_fade_seconds: float = 0.25

@onready var _plate_placeholder: ColorRect = %PlatePlaceholder
@onready var _plate_image: TextureRect = %PlateImage
@onready var _plate_fade: ColorRect = %PlateFade
@onready var _status: Label = %Status
@onready var _error: Label = %Error
@onready var _content: Control = %Content
@onready var _location_name: Label = %LocationName
@onready var _lighting: Label = %Lighting
@onready var _description: Label = %LocationDescription
@onready var _hotspots: VBoxContainer = %Hotspots
@onready var _characters: VBoxContainer = %Characters
@onready var _actions: VBoxContainer = %Actions
@onready var _exits: VBoxContainer = %Exits
@onready var _map: LocationMap = %Map
@onready var _map_empty: Label = %MapEmpty
@onready var _confirm: ConfirmationDialog = %Confirm


func _init() -> void:
	_art = ArtLibrary.new()
	_art.name = "ArtLibrary"
	_art.art_changed.connect(_on_art_changed)
	add_child(_art)


## Called by SceneRouter before _ready. A screen that never gets params was run on its own.
func set_params(params: Dictionary) -> void:
	_params = params
	_params_received = true


## Listens to [param store] instead of the GameStore autoload (tests pass their own store).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.action_failed.disconnect(_on_action_failed)
		_store.action_resolved.disconnect(_on_dialogue_result)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.action_failed.connect(_on_action_failed)
		_store.action_resolved.connect(_on_dialogue_result)
		_store.connection_state_changed.connect(_on_connection_state_changed)
	if is_node_ready():
		_refresh()


func _ready() -> void:
	_art.set_scenario(_text(_params.get(PARAM_SCENARIO)))
	_confirm.confirmed.connect(_on_confirmed)
	_confirm.canceled.connect(_on_confirm_canceled)
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


## True while an action was sent and neither a new view nor a failure has arrived.
func is_awaiting_result() -> bool:
	return _pending


func get_known_map() -> KnownMap:
	return _known_map


func get_art_library() -> ArtLibrary:
	return _art


## Path of the plate the screen shows or waits for; "" without a location or a valid id.
func get_plate_path() -> String:
	return _plate_path


func is_plate_fading() -> bool:
	return _plate_tween != null and _plate_tween.is_valid() and _plate_tween.is_running()


## Picks what to show: an explicit preview, the store's view, the standalone preview or nothing.
func _refresh() -> void:
	var requested: String = str(_params.get(PARAM_PREVIEW, ""))
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
		push_error("Exploration: view with the server-only field '%s' is not shown" % leaked)
		view = ReadOnly.empty()
	_view = view
	_known_map.observe(view)
	_render()


func _render() -> void:
	_action_buttons.clear()
	for container: Container in [_hotspots, _characters, _actions, _exits]:
		_clear(container)
	_map.show_map(_known_map)
	_map_empty.visible = _known_map.is_empty()
	_map_empty.text = NO_MAP_TEXT
	var location: Dictionary = _dict(_view.get("location"))
	if location.is_empty():
		_content.visible = false
		_status.text = (PREVIEW_FAILED_TEXT % _preview_name) if _preview_failed else NO_VIEW_TEXT
		_plate_placeholder.color = _placeholder_color("", "")
		var none: Array[String] = []
		_show_art("", "", none, none)
		return
	_content.visible = true
	_status.text = (PREVIEW_TEXT % _preview_name) if is_preview() else ""
	var location_id: String = _text(location.get("id"))
	var lighting: String = _text(location.get("lighting"))
	var title: String = _text(location.get("name"))
	_location_name.text = title if not title.is_empty() else UNTITLED_TEXT
	_description.text = _text(location.get("description"))
	_lighting.text = str(LIGHTING_TEXT.get(lighting, ""))
	_plate_placeholder.color = _placeholder_color(location_id, lighting)

	var hotspots: Array[Dictionary] = _dicts(location.get("hotspots"))
	var characters: Array[Dictionary] = _dicts(_view.get("presentCharacters"))
	var exits: Array[Dictionary] = _dicts(location.get("exits"))
	var partner: String = _text(_dict(_view.get("interaction")).get("characterId"))
	var hotspot_ids: Array[String] = _ids(hotspots, "id")
	var character_ids: Array[String] = _ids(characters, "id")
	var exit_ids: Array[String] = _ids(exits, "locationId")
	var portraits: Array[String] = []
	for character: Dictionary in characters:
		portraits.append(_art.portrait(_text(character.get("portraitRef"))))
	_show_art(location_id, lighting, exit_ids, portraits)

	# Each available action is shown once: next to the thing it targets, or in the general list.
	var by_hotspot: Dictionary = {}
	var by_character: Dictionary = {}
	var by_exit: Dictionary = {}
	var general: Array[Dictionary] = []
	for entry: Dictionary in _dicts(_view.get("availableActions")):
		var action: Dictionary = _dict(entry.get("action"))
		var kind: String = _text(action.get("type"))
		if not ProtocolConstants.DESKTOP_ACTIONS.has(kind):
			continue
		if kind == ProtocolConstants.ACTION_MOVE and exit_ids.has(_text(action.get("locationId"))):
			_group(by_exit, _text(action.get("locationId")), entry)
		elif (
			kind == ProtocolConstants.ACTION_EXAMINE_HOTSPOT
			and hotspot_ids.has(_text(action.get("hotspotId")))
		):
			_group(by_hotspot, _text(action.get("hotspotId")), entry)
		elif (
			(kind == ProtocolConstants.ACTION_TALK or kind == ProtocolConstants.ACTION_INTERROGATE)
			and character_ids.has(_text(action.get("characterId")))
		):
			_group(by_character, _text(action.get("characterId")), entry)
		else:
			general.append(entry)

	for hotspot: Dictionary in hotspots:
		var caption: String = _text(hotspot.get("name"))
		var examined: Variant = hotspot.get("examined")
		if examined is bool and examined:
			caption += EXAMINED_SUFFIX
		_add_row(_hotspots, caption, _grouped(by_hotspot, _text(hotspot.get("id"))))
	for index: int in characters.size():
		var character: Dictionary = characters[index]
		var character_id: String = _text(character.get("id"))
		var caption: String = _text(character.get("name"))
		var demeanor: String = _text(character.get("demeanor"))
		if not demeanor.is_empty():
			caption += " — " + demeanor
		var row: VBoxContainer = _add_character_row(
			caption, portraits[index], _grouped(by_character, character_id)
		)
		if not partner.is_empty() and character_id == partner:
			var resume: Button = Button.new()
			resume.text = "Продолжить разговор"
			resume.pressed.connect(_resume_dialogue.bind(character_id))
			row.add_child(resume)
			_action_buttons.append(resume)
	for exit: Dictionary in exits:
		_add_exit_row(exit, _grouped(by_exit, _text(exit.get("locationId"))))
	for entry: Dictionary in general:
		_actions.add_child(_make_action_button(entry, ""))

	_add_placeholder(_hotspots, NO_HOTSPOTS_TEXT)
	_add_placeholder(_characters, NO_CHARACTERS_TEXT)
	_add_placeholder(_exits, NO_EXITS_TEXT)
	_add_placeholder(_actions, NO_ACTIONS_TEXT)
	_update_buttons()


func _add_row(container: Container, caption: String, entries: Array[Dictionary]) -> HBoxContainer:
	var row: HBoxContainer = HBoxContainer.new()
	var label: Label = Label.new()
	label.text = caption
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	row.add_child(label)
	for entry: Dictionary in entries:
		row.add_child(_make_action_button(entry, ""))
	container.add_child(row)
	return row


## A present character: the framed portrait (or the silhouette) with the name and demeanor,
## then the actions aimed at this character, one per line.
func _add_character_row(
	caption: String, portrait_path: String, entries: Array[Dictionary]
) -> VBoxContainer:
	var row: VBoxContainer = VBoxContainer.new()
	var header: HBoxContainer = HBoxContainer.new()
	header.add_theme_constant_override("separation", 16)
	var frame: PortraitFrame = PortraitFrame.new()
	frame.show_portrait(_art.request(portrait_path))
	if not portrait_path.is_empty():
		if not _portrait_frames.has(portrait_path):
			_portrait_frames[portrait_path] = []
		(_portrait_frames[portrait_path] as Array).append(frame)
	header.add_child(frame)
	var label: Label = Label.new()
	label.text = caption
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	header.add_child(label)
	row.add_child(header)
	for entry: Dictionary in entries:
		row.add_child(_make_action_button(entry, ""))
	_characters.add_child(row)
	return row


## Shows the plate of [param location_id] in [param lighting] and keeps in the art cache only that
## location (every lighting level, so a change of light is ready), its neighbours and the
## portraits on screen (art-direction.md §7.4).
func _show_art(
	location_id: String, lighting: String, neighbours: Array[String], portraits: Array[String]
) -> void:
	_portrait_frames.clear()
	var path: String = _art.plate(location_id, lighting)
	var keep: Array[String] = [path]
	keep.append_array(_art.existing_plates(location_id))
	for neighbour: String in neighbours:
		keep.append_array(_art.existing_plates(neighbour))
	keep.append_array(portraits)
	_art.retain(keep)
	for wanted: String in keep:
		_art.request(wanted)
	var relit: bool = (
		not location_id.is_empty()
		and location_id == _plate_location
		and not _plate_lighting.is_empty()
		and lighting != _plate_lighting
	)
	_plate_location = location_id
	_plate_lighting = lighting
	_plate_path = path
	if relit and is_inside_tree() and plate_fade_seconds > 0.0:
		_fade_plate()
	elif not _plate_swap_pending:
		_apply_plate()


## Dips the plate to black, swaps it at full black and fades back.
func _fade_plate() -> void:
	if _plate_tween != null and _plate_tween.is_valid():
		_plate_tween.kill()
	_plate_swap_pending = true
	_plate_tween = create_tween()
	var remaining: float = (1.0 - _plate_fade.color.a) * plate_fade_seconds
	_plate_tween.tween_property(_plate_fade, "color:a", 1.0, remaining)
	_plate_tween.tween_callback(_apply_plate)
	_plate_tween.tween_property(_plate_fade, "color:a", 0.0, plate_fade_seconds)


func _apply_plate() -> void:
	_plate_swap_pending = false
	var texture: Texture2D = _art.get_texture(_plate_path)
	_plate_image.texture = texture
	_plate_image.visible = texture != null


func _on_art_changed(path: String) -> void:
	if path == _plate_path and not _plate_swap_pending:
		_apply_plate()
	var frames: Variant = _portrait_frames.get(path)
	if frames is Array:
		for frame: Variant in frames as Array:
			if frame is PortraitFrame and is_instance_valid(frame):
				(frame as PortraitFrame).show_portrait(_art.get_texture(path))


func _add_exit_row(exit: Dictionary, moves: Array[Dictionary]) -> void:
	var caption: String = _text(exit.get("name"))
	var travel: String = CostFormat.format_minutes(exit.get("minutes"))
	if not travel.is_empty():
		caption += " · путь ≈ " + travel
	var blocked: String = _text(exit.get("blockedReason"))
	if not blocked.is_empty():
		caption += " · закрыто: " + blocked
	var row: HBoxContainer = HBoxContainer.new()
	var label: Label = Label.new()
	label.text = caption
	label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	row.add_child(label)
	for entry: Dictionary in moves:
		row.add_child(_make_action_button(entry, GO_TEXT))
	if moves.is_empty() and blocked.is_empty():
		var unavailable: Label = Label.new()
		unavailable.text = EXIT_UNAVAILABLE_TEXT
		row.add_child(unavailable)
	_exits.add_child(row)


func _make_action_button(entry: Dictionary, caption: String) -> Button:
	var action: Dictionary = _dict(entry.get("action"))
	var label: String = caption if not caption.is_empty() else _text(entry.get("label"))
	if label.is_empty():
		label = _text(action.get("type"))
	var reason: String = _text(entry.get("blockedReason"))
	var button: Button = Button.new()
	button.text = "%s · %s" % [label, CostFormat.format_cost(entry.get("costPreview"))]
	if not reason.is_empty():
		button.text += " (%s)" % reason
		button.tooltip_text = reason
	button.set_meta(META_ACTION, action)
	button.set_meta(META_BLOCKED, not reason.is_empty())
	button.pressed.connect(_on_action_pressed.bind(entry))
	_action_buttons.append(button)
	return button


func _on_action_pressed(entry: Dictionary) -> void:
	if _pending or _opening_dialogue or not _text(entry.get("blockedReason")).is_empty():
		return
	var action: Dictionary = _dict(entry.get("action"))
	var preview: Variant = entry.get("costPreview")
	if CostFormat.is_long(preview):
		_confirm_action = action
		_confirm.dialog_text = CONFIRM_TEXT % [_text(entry.get("label")), CostFormat.format_cost(preview)]
		_confirm.popup_centered()
		return
	_send(action)


func _on_confirmed() -> void:
	if _confirm_action.is_empty():
		return
	var action: Dictionary = _confirm_action
	_confirm_action = {}
	_send(action)


func _on_confirm_canceled() -> void:
	_confirm_action = {}


func _send(action: Dictionary) -> void:
	if _pending or _opening_dialogue:
		return
	_dialogue_error = false
	_error.text = ""
	if _store == null:
		_show_error(GameStoreScript.ERROR_NOT_CONNECTED, "")
		return
	_pending = true
	_update_buttons()
	# A refusal comes back as action_failed (even synchronously); a success as view_changed.
	if _store.request_action(action) != OK:
		return
	var kind: String = _text(action.get("type"))
	if kind == ProtocolConstants.ACTION_TALK or kind == ProtocolConstants.ACTION_INTERROGATE:
		_dialogue_target = _text(action.get("characterId"))
		_dialogue_request_id = _store.get_last_action_request_id()
		if not _dialogue_request_id.is_empty():
			_status.text = DIALOGUE_WAIT_TEXT


func _resume_dialogue(character_id: String) -> void:
	if not _pending and not _opening_dialogue:
		_open_dialogue(character_id)


func _open_dialogue(character_id: String) -> void:
	var router: SceneRouterScript = get_node_or_null(^"/root/SceneRouter") as SceneRouterScript
	if router == null:
		return
	var params: Dictionary = {"characterId": character_id}
	if is_preview():
		params["preview"] = _preview_name
	_opening_dialogue = router.goto(&"dialogue", params) == OK
	_update_buttons()


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	var open_partner: String = ""
	if _dialogue_request_id.is_empty() or _dialogue_accepted:
		if _text(_dict(view.get("interaction")).get("characterId")) == _dialogue_target:
			open_partner = _dialogue_target
		_clear_pending()
	_preview_name = ""
	_preview_failed = false
	if not _dialogue_error:
		_error.text = ""
	_show(view)
	if not open_partner.is_empty():
		_open_dialogue(open_partner)


func _on_action_failed(code: String, message: String) -> void:
	if not _dialogue_request_id.is_empty():
		return
	_clear_pending()
	_show_error(code, message)
	_update_buttons()


func _on_dialogue_result(request_id: String, ok: bool, code: String, message: String) -> void:
	if _dialogue_request_id.is_empty() or request_id != _dialogue_request_id:
		return
	if ok:
		_dialogue_accepted = true
	else:
		_clear_pending()
		_on_action_failed(code, message)
		_dialogue_error = true


func _clear_pending() -> void:
	_pending = false
	_dialogue_target = ""
	_dialogue_request_id = ""
	_dialogue_accepted = false
	if _status.text == DIALOGUE_WAIT_TEXT:
		_status.text = ""


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.ONLINE:
		return
	_clear_pending()
	if state == BackendScript.ConnectionState.OFFLINE and not is_preview():
		# The session is over: GameStore forgot the view, the map of that session goes too.
		_dialogue_error = false
		_error.text = ""
		_known_map.clear()
		_show(ReadOnly.empty())
	else:
		_update_buttons()


func _show_error(code: String, message: String) -> void:
	var text: String = str(ERROR_TEXT.get(code, ERROR_FALLBACK_TEXT % code))
	if not message.is_empty():
		text += " " + message
	_error.text = text


func _update_buttons() -> void:
	if not _dialogue_request_id.is_empty():
		_status.text = DIALOGUE_WAIT_TEXT
	for button: Button in _action_buttons:
		if is_instance_valid(button):
			var blocked: bool = button.get_meta(META_BLOCKED, false)
			button.disabled = _pending or _opening_dialogue or blocked


## Plate placeholder for a location without art: a hue from the location id, darker in dim or
## dark lighting.
static func _placeholder_color(location_id: String, lighting: String) -> Color:
	if location_id.is_empty():
		return Color(0.08, 0.08, 0.09)
	var hue: float = float(location_id.hash() & 0xFFFF) / 65536.0
	var value: float = LIGHTING_VALUE.get(lighting, LIGHTING_VALUE["dim"])
	return Color.from_hsv(hue, 0.35, value)


static func _clear(container: Container) -> void:
	for child: Node in container.get_children():
		container.remove_child(child)
		child.queue_free()


static func _add_placeholder(container: Container, text: String) -> void:
	if container.get_child_count() > 0:
		return
	var label: Label = Label.new()
	label.text = text
	label.modulate.a = 0.6
	container.add_child(label)


static func _group(groups: Dictionary, key: String, entry: Dictionary) -> void:
	if not groups.has(key):
		var entries: Array[Dictionary] = []
		groups[key] = entries
	var bucket: Array[Dictionary] = groups[key]
	bucket.append(entry)


static func _grouped(groups: Dictionary, key: String) -> Array[Dictionary]:
	if groups.has(key):
		var entries: Array[Dictionary] = groups[key]
		return entries
	var none: Array[Dictionary] = []
	return none


static func _ids(items: Array[Dictionary], key: String) -> Array[String]:
	var result: Array[String] = []
	for item: Dictionary in items:
		var value: String = _text(item.get(key))
		if not value.is_empty():
			result.append(value)
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


static func _text(value: Variant) -> String:
	if value is String:
		var text: String = value
		return text
	return ""
