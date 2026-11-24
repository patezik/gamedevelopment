class_name HorrorFx
extends CanvasLayer
## Horror screen effects (GDT-010): the screen wavers at low sanity and crackles with Static.
##
## A visual reading of two values the PlayerView already carries, `vitals.sanity` and `static`
## (godot-client.md §1, §7): the overlay computes no game rule and reads nothing else. It lives on
## the scene root ([method install]), so it survives SceneRouter screen changes, and follows the
## `GameStore` and `Settings` autoloads by itself. With «Снизить визуальные эффекты» on, or
## without a view, the effect is hidden and costs nothing.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SettingsScript = preload("res://src/autoload/settings.gd")

const SCENE_PATH: String = "res://src/scenes/overlays/horror_fx/horror_fx.tscn"
const NODE_NAME: String = "HorrorFx"
## Above the screens and the HUD, below DebugOverlay and the SceneRouter curtain (128).
const OVERLAY_LAYER: int = 100

## Presentation thresholds mirroring survival-horror.md: sanity ≤ 5 brings the first
## interference, Static 25 the first glitches. Below them the screen is clean.
const SANITY_ONSET: int = 5
const STATIC_ONSET: int = 25
const STATIC_MAX: int = 100
## Strength right at a threshold, so crossing it is noticeable; it grows to 1.0 at sanity 0 or
## Static 100.
const ONSET_STRENGTH: float = 0.2
## How fast the shown strength follows a new view, per real second.
const FOLLOW_RATE: float = 0.6
const EPSILON: float = 0.001

const UNIFORM_DISTORTION: StringName = &"distortion"
const UNIFORM_NOISE: StringName = &"noise"

var _store: GameStoreScript
var _settings: SettingsScript
var _target_distortion: float = 0.0
var _target_noise: float = 0.0
var _distortion: float = 0.0
var _noise: float = 0.0

@onready var _effect: ColorRect = %Effect
@onready var _material: ShaderMaterial = _effect.material as ShaderMaterial


## Adds the overlay to [param root] once; a second call returns the overlay already there.
static func install(root: Node) -> HorrorFx:
	if root == null:
		return null
	var existing: Node = root.get_node_or_null(NodePath(NODE_NAME))
	if existing is HorrorFx:
		return existing as HorrorFx
	var scene: PackedScene = load(SCENE_PATH) as PackedScene
	var overlay: HorrorFx = scene.instantiate() as HorrorFx
	overlay.name = NODE_NAME
	root.add_child.call_deferred(overlay)
	return overlay


## Strength of the low-sanity distortion for [param view], 0..1; 0 without a valid sanity.
static func distortion_for(view: Dictionary) -> float:
	var sanity: Variant = sanity_of(view)
	if sanity == null or (sanity as int) > SANITY_ONSET:
		return 0.0
	var depth: float = float(SANITY_ONSET - maxi(sanity as int, 0)) / float(SANITY_ONSET)
	return lerpf(ONSET_STRENGTH, 1.0, depth)


## Strength of the Static noise for [param view], 0..1; 0 without a valid Static.
static func noise_for(view: Dictionary) -> float:
	var level: Variant = static_of(view)
	if level == null or (level as int) < STATIC_ONSET:
		return 0.0
	var depth: float = float(mini(level as int, STATIC_MAX) - STATIC_ONSET)
	return lerpf(ONSET_STRENGTH, 1.0, depth / float(STATIC_MAX - STATIC_ONSET))


## `vitals.sanity` of [param view] as an int, or null when absent or not a whole number.
static func sanity_of(view: Dictionary) -> Variant:
	var vitals: Variant = view.get("vitals")
	if not vitals is Dictionary:
		return null
	return _whole_number((vitals as Dictionary).get("sanity"))


## `static` of [param view] as an int, or null when absent or not a whole number.
static func static_of(view: Dictionary) -> Variant:
	return _whole_number(view.get("static"))


static func _whole_number(value: Variant) -> Variant:
	if value is int:
		return value
	if value is float:
		var number: float = value
		if is_finite(number) and number == floorf(number):
			return int(number)
	return null


func _ready() -> void:
	layer = OVERLAY_LAYER
	_effect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	if _settings == null:
		var settings: Node = get_node_or_null(^"/root/Settings")
		if settings is SettingsScript:
			bind_settings(settings as SettingsScript)
	if _store == null:
		var store: Node = get_node_or_null(^"/root/GameStore")
		if store is GameStoreScript:
			bind_store(store as GameStoreScript)
	_refresh()


## Follows [param store] instead of the current one and takes its current view at once.
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		if _store.view_changed.is_connected(_on_view_changed):
			_store.view_changed.disconnect(_on_view_changed)
		if _store.connection_state_changed.is_connected(_on_connection_state_changed):
			_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	var view: Dictionary = {}
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.connection_state_changed.connect(_on_connection_state_changed)
		if _store.has_view():
			view = _store.get_view()
	show_view(view)
	finish_transition()


## Follows [param settings] for «Снизить визуальные эффекты».
func bind_settings(settings: SettingsScript) -> void:
	if _settings != null and is_instance_valid(_settings):
		if _settings.reduce_visual_effects_changed.is_connected(_on_reduce_changed):
			_settings.reduce_visual_effects_changed.disconnect(_on_reduce_changed)
	_settings = settings
	if _settings != null:
		_settings.reduce_visual_effects_changed.connect(_on_reduce_changed)
	_refresh()


## Aims the effect at [param view]; the shown strength follows over a short real-time blend.
## A view with a server-only key is treated as no view (the store refuses such views too).
func show_view(view: Dictionary) -> void:
	if not GameStoreScript.find_forbidden_key(view).is_empty():
		view = {}
	_target_distortion = distortion_for(view)
	_target_noise = noise_for(view)
	_refresh()


## Jumps to the target strength at once (no blend).
func finish_transition() -> void:
	_distortion = _target_distortion
	_noise = _target_noise
	_refresh()


func is_reduced() -> bool:
	return _settings != null and is_instance_valid(_settings) and _settings.get_reduce_visual_effects()


## True while the effect is drawn (not reduced and some strength left).
func is_effect_visible() -> bool:
	return is_node_ready() and _effect.visible


func get_target_distortion() -> float:
	return _target_distortion


func get_target_noise() -> float:
	return _target_noise


func get_distortion() -> float:
	return _distortion


func get_noise() -> float:
	return _noise


func _process(delta: float) -> void:
	_distortion = move_toward(_distortion, _target_distortion, FOLLOW_RATE * delta)
	_noise = move_toward(_noise, _target_noise, FOLLOW_RATE * delta)
	_refresh()


func _refresh() -> void:
	if is_reduced():
		_distortion = 0.0
		_noise = 0.0
	var settled: bool = (
		is_equal_approx(_distortion, _target_distortion) and is_equal_approx(_noise, _target_noise)
	)
	var active: bool = not is_reduced() and (_distortion > EPSILON or _noise > EPSILON)
	set_process(not is_reduced() and not settled)
	if not is_node_ready():
		return
	_effect.visible = active
	_material.set_shader_parameter(UNIFORM_DISTORTION, _distortion)
	_material.set_shader_parameter(UNIFORM_NOISE, _noise)


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	show_view(view)


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	# OFFLINE ends the session and clears the store without a new view.
	if state == BackendScript.ConnectionState.OFFLINE:
		show_view({})


func _on_reduce_changed(_enabled: bool) -> void:
	_refresh()
