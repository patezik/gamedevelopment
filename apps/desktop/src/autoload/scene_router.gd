extends CanvasLayer
## SceneRouter: switches screens behind a fade to black, so screens never reference each other.
##
## [method goto] looks the screen up in the registry, fades to black, replaces the current screen,
## hands the new one a read-only copy of the params and fades back in. While a transition runs,
## a new request waits for it (the latest request wins) and a repeat of the pending destination
## with the same params is ignored. Input is blocked by the curtain during a transition.

const ReadOnly = preload("res://src/util/read_only.gd")

## A transition to [param screen] began (the curtain starts to close).
signal transition_started(screen: StringName)
## [param screen] is mounted and received [param params] (read-only); the curtain opens next.
signal screen_changed(screen: StringName, params: Dictionary)
## A transition to [param screen] was refused or failed; the current screen stays.
## [param reason]: "unknown_screen", "invalid_params" or "load_failed".
signal transition_failed(screen: StringName, reason: String)

## Screen id -> scene path. Screen tasks add their entries here; tests use register_screen().
const SCREENS: Dictionary = {
	&"bootstrap": "res://src/scenes/bootstrap.tscn",
	&"exploration": "res://src/scenes/exploration/exploration.tscn",
	&"case_board": "res://src/scenes/case_board/case_board.tscn",
}
const DEFAULT_FADE_SECONDS: float = 0.25
## Optional method of a screen's root node, called with the params before the node enters the
## tree (that is, before its _ready): func set_params(params: Dictionary) -> void
const PARAMS_METHOD: StringName = &"set_params"
## The curtain is drawn above every screen layer.
const CURTAIN_LAYER: int = 128


## A requested transition.
class Route:
	var screen: StringName
	var path: String
	var params: Dictionary

	func _init(route_screen: StringName, route_path: String, route_params: Dictionary) -> void:
		screen = route_screen
		path = route_path
		params = route_params


## Parent node for screens; null mounts each screen as SceneTree.current_scene.
var host: Node = null
## Duration of each half of the transition (fade out, fade in), in real seconds.
var fade_seconds: float = DEFAULT_FADE_SECONDS

var _screens: Dictionary = SCREENS.duplicate()
var _curtain: ColorRect
var _current_screen: StringName = &""
var _current_params: Dictionary = ReadOnly.empty()
var _current_node: Node = null
var _active: Route = null
var _queued: Route = null


func _ready() -> void:
	layer = CURTAIN_LAYER
	process_mode = Node.PROCESS_MODE_ALWAYS
	_curtain = ColorRect.new()
	_curtain.name = "Curtain"
	_curtain.color = Color(0.0, 0.0, 0.0, 0.0)
	_curtain.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_curtain.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(_curtain)


## Adds or replaces a screen in the registry. [param path] must be a loadable PackedScene.
func register_screen(screen: StringName, path: String) -> Error:
	if screen.is_empty() or not ResourceLoader.exists(path, "PackedScene"):
		push_error("SceneRouter: cannot register screen '%s' at '%s'" % [screen, path])
		return ERR_INVALID_PARAMETER
	_screens[screen] = path
	return OK


func has_screen(screen: StringName) -> bool:
	return _screens.has(screen)


## The id of the last mounted screen; empty before the first transition.
func get_current_screen() -> StringName:
	return _current_screen


## Params the current screen received (read-only).
func get_current_params() -> Dictionary:
	return _current_params


func is_transitioning() -> bool:
	return _active != null


## Opens [param screen] with [param params] (plain data only: no Objects at any depth; the screen
## gets a read-only deep copy). Returns OK when the transition started or was queued,
## ERR_BUSY when the same destination with the same params is already pending,
## ERR_DOES_NOT_EXIST for an unknown screen and ERR_INVALID_PARAMETER for params with Objects.
func goto(screen: StringName, params: Dictionary = {}) -> Error:
	if not _screens.has(screen):
		push_error("SceneRouter: unknown screen '%s'" % screen)
		transition_failed.emit(screen, "unknown_screen")
		return ERR_DOES_NOT_EXIST
	if ReadOnly.has_object(params):
		push_error("SceneRouter: params of screen '%s' must be plain data" % screen)
		transition_failed.emit(screen, "invalid_params")
		return ERR_INVALID_PARAMETER
	if not is_inside_tree():
		return ERR_UNCONFIGURED
	var frozen: Dictionary = ReadOnly.freeze(params)
	var route: Route = Route.new(screen, str(_screens[screen]), frozen)
	if _active != null:
		var pending: Route = _queued if _queued != null else _active
		if pending.screen == route.screen and pending.params == route.params:
			return ERR_BUSY
		_queued = route
		return OK
	_run(route)
	return OK


func _run(first: Route) -> void:
	_active = first
	_curtain.mouse_filter = Control.MOUSE_FILTER_STOP
	transition_started.emit(first.screen)
	await _fade_to(1.0)
	# Requests that arrived while the curtain was closing are mounted behind it right away.
	while true:
		_mount(_active)
		if _queued == null:
			break
		_active = _queued
		_queued = null
		transition_started.emit(_active.screen)
	await _fade_to(0.0)
	_curtain.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_active = null
	if _queued != null:
		var next: Route = _queued
		_queued = null
		_run(next)


func _fade_to(alpha: float) -> void:
	var tween: Tween = create_tween()
	tween.tween_property(_curtain, "color:a", alpha, maxf(fade_seconds, 0.0))
	await tween.finished


func _mount(route: Route) -> void:
	var packed: PackedScene = ResourceLoader.load(route.path, "PackedScene") as PackedScene
	var node: Node = packed.instantiate() if packed != null else null
	if node == null:
		push_error("SceneRouter: cannot load screen '%s' from '%s'" % [route.screen, route.path])
		transition_failed.emit(route.screen, "load_failed")
		return
	if node.has_method(PARAMS_METHOD):
		node.call(PARAMS_METHOD, route.params)
	var use_host: bool = host != null and is_instance_valid(host)
	var parent: Node = host if use_host else get_tree().root
	var previous: Node = _current_node if use_host else get_tree().current_scene
	if previous != null and is_instance_valid(previous):
		var previous_parent: Node = previous.get_parent()
		if previous_parent != null:
			previous_parent.remove_child(previous)
		previous.queue_free()
	parent.add_child(node)
	if not use_host:
		get_tree().current_scene = node
	_current_node = node
	_current_screen = route.screen
	_current_params = route.params
	screen_changed.emit(route.screen, route.params)
