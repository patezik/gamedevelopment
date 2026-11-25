extends Node
## Opens the `ending` screen when the game is over, whatever screen is open.
##
## The game is over when the server's PlayerView carries `ending` (ENG-006): after an accusation
## that ended the game, at death, madness or when time ran out. The watcher listens to GameStore
## (`view_changed`, and the `gameOver` event, which is followed by such a view) and asks
## SceneRouter for the `ending` screen once per ended game. It decides nothing about the ending:
## the view says which one it is.
##
## Installed once on the scene root by bootstrap ([method install]), next to HorrorFx and the debug
## overlay, so it outlives SceneRouter screen changes.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")

const NODE_NAME: String = "EndingWatcher"
const ENDING_SCREEN: StringName = &"ending"

var _store: GameStoreScript = null
var _router: Node = null
## True once the ending of the current session was opened; a new session (OFFLINE) clears it.
var _opened: bool = false


## Adds the watcher under [param root] (once) and returns it.
static func install(root: Node) -> Node:
	if root == null:
		return null
	var existing: Node = root.get_node_or_null(NodePath(NODE_NAME))
	if existing != null:
		return existing
	var watcher: Node = (load("res://src/scenes/ending/ending_watcher.gd") as GDScript).new() as Node
	watcher.name = NODE_NAME
	root.add_child.call_deferred(watcher)
	return watcher


## Asks [param router] for the `ending` screen unless it is already shown or on its way.
## Returns OK when a transition started, ERR_ALREADY_EXISTS when the ending is already shown,
## ERR_BUSY when it is already pending and ERR_UNCONFIGURED without a router.
static func open_ending(router: Node) -> Error:
	if not router is SceneRouterScript:
		return ERR_UNCONFIGURED
	var scene_router: SceneRouterScript = router as SceneRouterScript
	if scene_router.get_current_screen() == ENDING_SCREEN and not scene_router.is_transitioning():
		return ERR_ALREADY_EXISTS
	return scene_router.goto(ENDING_SCREEN)


func _ready() -> void:
	if _store == null:
		var autoload: Node = get_node_or_null(^"/root/GameStore")
		if autoload is GameStoreScript:
			bind_store(autoload as GameStoreScript)
	if _router == null:
		_router = get_node_or_null(^"/root/SceneRouter")


## Listens to [param store] instead of the GameStore autoload (tests pass their own store).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.event_received.disconnect(_on_event_received)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	_opened = false
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.event_received.connect(_on_event_received)
		_store.connection_state_changed.connect(_on_connection_state_changed)
		if _store.has_view():
			_check(_store.get_view())


## Uses [param router] instead of the SceneRouter autoload (tests pass their own router).
func bind_router(router: Node) -> void:
	_router = router


func has_opened_ending() -> bool:
	return _opened


func _check(view: Dictionary) -> void:
	if _opened or not view.has("ending"):
		return
	var result: Error = open_ending(_router)
	_opened = result == OK or result == ERR_BUSY or result == ERR_ALREADY_EXISTS


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	_check(view)


func _on_event_received(event: Dictionary) -> void:
	if str(event.get("type", "")) == ProtocolConstants.EVENT_GAME_OVER and _store != null:
		_check(_store.get_view())


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.OFFLINE:
		_opened = false
