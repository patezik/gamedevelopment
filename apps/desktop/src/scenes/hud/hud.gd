extends Control
## HUD overlay: the clock, day and period, the time left, the hero's vitals, Static and the phone.
##
## A reusable overlay, not a SceneRouter screen: a screen instances `hud.tscn` (or puts it on a
## CanvasLayer) and the HUD follows the `GameStore` autoload by itself. It only shows what the
## PlayerView and `peer.status` carry (ADR 0002): no value is computed or invented, an absent one
## is shown as a dash.
##
## When a new view moves the clock face forward, the displayed clock and time left roll from the
## previous server values to the new ones (a real-time UI animation between two states the server
## already sent; the game time itself is final). The period label switches when the roll ends, so
## the HUD never shows a period the displayed clock has not reached yet.

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const HudFormat = preload("res://src/scenes/hud/hud_format.gd")

## Real seconds the roll spends per game minute, bounded by the two values below.
@export var roll_seconds_per_minute: float = 0.004
@export var min_roll_seconds: float = 0.3
@export var max_roll_seconds: float = 1.2

var _store: GameStoreScript
var _view: Dictionary = {}
var _peer_phone: String = GameStoreScript.PEER_UNKNOWN

# The clock of the latest view: the end point of a roll. `_target_minute` is the clock face as
# minutes since the start of day 0, or -1 when the view has no complete clock face.
var _target_day: Variant = null
var _target_time: String = ""
var _target_minute: int = -1
var _target_period: String = ""
var _target_remaining: Variant = null
# What the HUD shows now and where the roll in progress started.
var _roll: Tween
var _roll_from_minute: float = 0.0
var _roll_from_remaining: Variant = null
var _displayed_minute: float = -1.0
var _displayed_remaining: Variant = null

@onready var _clock_label: Label = %ClockLabel
@onready var _period_label: Label = %PeriodLabel
@onready var _remaining_label: Label = %RemainingLabel
@onready var _health_label: Label = %HealthLabel
@onready var _health_bar: ProgressBar = %HealthBar
@onready var _sanity_label: Label = %SanityLabel
@onready var _sanity_bar: ProgressBar = %SanityBar
@onready var _fatigue_label: Label = %FatigueLabel
@onready var _fatigue_bar: ProgressBar = %FatigueBar
@onready var _static_label: Label = %StaticLabel
@onready var _static_bar: ProgressBar = %StaticBar
@onready var _phone_label: Label = %PhoneLabel
@onready var _battery_label: Label = %BatteryLabel


func _ready() -> void:
	if _store == null:
		var autoload: Node = get_node_or_null(^"/root/GameStore")
		if autoload is GameStoreScript:
			bind_store(autoload as GameStoreScript)
			return
	_stop_roll()
	_render_vitals()
	_render_phone()


## Follows [param store] instead of the current one and shows its current state at once.
## The HUD binds the `GameStore` autoload itself; tests and previews pass their own store.
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		if _store.view_changed.is_connected(_on_view_changed):
			_store.view_changed.disconnect(_on_view_changed)
		if _store.peer_status_changed.is_connected(_on_peer_status_changed):
			_store.peer_status_changed.disconnect(_on_peer_status_changed)
		if _store.connection_state_changed.is_connected(_on_connection_state_changed):
			_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	_peer_phone = GameStoreScript.PEER_UNKNOWN
	var view: Dictionary = {}
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.peer_status_changed.connect(_on_peer_status_changed)
		_store.connection_state_changed.connect(_on_connection_state_changed)
		_peer_phone = _store.get_phone_status()
		if _store.has_view():
			view = _store.get_view()
	show_view(view, false)


## Shows [param view]. With [param animate], a clock face that moved forward rolls to the new
## one; otherwise (the first view, a load or resync that moved the clock back, an incomplete
## clock) the HUD jumps straight to it. Vitals, Static and the phone update at once.
func show_view(view: Dictionary, animate: bool = true) -> void:
	_view = view
	var clock: Dictionary = HudFormat.read_dict(view, "clock")
	_target_day = HudFormat.read_int(clock, "day")
	_target_time = HudFormat.read_string(clock, "time")
	_target_minute = HudFormat.absolute_minute(_target_day, _target_time)
	_target_period = HudFormat.read_string(clock, "period")
	_target_remaining = HudFormat.read_int(clock, "remainingMinutes")
	if not is_node_ready():
		return
	var can_roll: bool = (
		animate
		and is_inside_tree()
		and _displayed_minute >= 0.0
		and _target_minute >= 0
		and float(_target_minute) > _displayed_minute
	)
	if can_roll:
		_start_roll()
	else:
		_stop_roll()
	_render_vitals()
	_render_phone()


## True while the clock rolls towards the latest view.
func is_time_rolling() -> bool:
	return _roll != null and _roll.is_valid() and _roll.is_running()


## Ends a roll at once and shows the latest view's clock.
func finish_time_roll() -> void:
	_stop_roll()


## The clock face the HUD shows now, as minutes since the start of day 0; -1 without a clock.
func get_displayed_minute() -> float:
	return _displayed_minute


## Shows the clock and time left at [param minute] (minutes since the start of day 0) on the way
## from the previous view to the latest one. The roll tween drives it; reaching the latest clock
## face shows the view's own values.
func show_clock_at(minute: float) -> void:
	if _target_minute < 0:
		return
	_displayed_minute = minf(minute, float(_target_minute))
	if _displayed_minute >= float(_target_minute):
		_render_clock_final()
		return
	var face: Vector2i = HudFormat.split_minute(floori(_displayed_minute))
	_clock_label.text = HudFormat.clock_text(face.x, HudFormat.format_clock(face.y))
	_displayed_remaining = _remaining_at(_displayed_minute)
	_remaining_label.text = HudFormat.remaining_text(_displayed_remaining)


func _start_roll() -> void:
	var from_minute: float = _displayed_minute
	_kill_roll()
	_roll_from_minute = from_minute
	_roll_from_remaining = _displayed_remaining
	var span: float = float(_target_minute) - from_minute
	var seconds: float = clampf(span * roll_seconds_per_minute, min_roll_seconds, max_roll_seconds)
	show_clock_at(from_minute)
	_roll = create_tween()
	_roll.tween_method(show_clock_at, from_minute, float(_target_minute), seconds)
	_roll.finished.connect(_render_clock_final)


func _stop_roll() -> void:
	_kill_roll()
	_render_clock_final()


func _kill_roll() -> void:
	if _roll != null and _roll.is_valid():
		_roll.kill()
	_roll = null


func _render_clock_final() -> void:
	_clock_label.text = HudFormat.clock_text(_target_day, _target_time)
	_period_label.text = HudFormat.period_text(_target_period)
	_remaining_label.text = HudFormat.remaining_text(_target_remaining)
	_displayed_minute = float(_target_minute)
	_displayed_remaining = _target_remaining


# The time left at [param minute] of the roll: the previous and the latest server values blended
# by the roll's progress. Without a previous value the latest one is shown.
func _remaining_at(minute: float) -> Variant:
	if not _target_remaining is int:
		return null
	if not _roll_from_remaining is int:
		return _target_remaining
	var span: float = float(_target_minute) - _roll_from_minute
	if span <= 0.0:
		return _target_remaining
	var progress: float = clampf((minute - _roll_from_minute) / span, 0.0, 1.0)
	var from_value: float = float(_roll_from_remaining as int)
	return roundi(lerpf(from_value, float(_target_remaining as int), progress))


func _render_vitals() -> void:
	var vitals: Dictionary = HudFormat.read_dict(_view, "vitals")
	var health: Variant = HudFormat.read_int(vitals, "health")
	var sanity: Variant = HudFormat.read_int(vitals, "sanity")
	var fatigue: Variant = HudFormat.read_int(vitals, "fatigue")
	var static_level: Variant = HudFormat.read_int(_view, "static")
	_health_label.text = "Здоровье %s" % HudFormat.scale_text(health, HudFormat.HEALTH_MAX)
	_sanity_label.text = "Рассудок %s" % HudFormat.scale_text(sanity, HudFormat.SANITY_MAX)
	_fatigue_label.text = "Усталость %s" % HudFormat.percent_text(fatigue)
	_static_label.text = "Static %s" % HudFormat.percent_text(static_level)
	_set_bar(_health_bar, health)
	_set_bar(_sanity_bar, sanity)
	_set_bar(_fatigue_bar, fatigue)
	_set_bar(_static_bar, static_level)


func _render_phone() -> void:
	var phone: Dictionary = HudFormat.read_dict(_view, "phone")
	var state: String = HudFormat.phone_state(_peer_phone, phone)
	_phone_label.text = HudFormat.phone_text(state)
	_battery_label.text = HudFormat.battery_text(phone, state)


static func _set_bar(bar: ProgressBar, value: Variant) -> void:
	var known: bool = value is int
	bar.value = float(value as int) if known else 0.0
	bar.modulate.a = 1.0 if known else 0.35


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	show_view(view, true)


func _on_peer_status_changed(_desktop: String, phone: String) -> void:
	_peer_phone = phone
	if is_node_ready():
		_render_phone()


func _on_connection_state_changed(_state: BackendScript.ConnectionState) -> void:
	# OFFLINE clears the store without a view_changed: the session ended, so the HUD clears too.
	if _store != null and not _store.has_view() and not _view.is_empty():
		_peer_phone = _store.get_phone_status()
		show_view({}, false)
