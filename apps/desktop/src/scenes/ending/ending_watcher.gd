extends Node
## Opens the `ending` screen when the game is over, whatever screen is open.
##
## The game is over when the server's PlayerView carries `ending` (ENG-006): after an accusation
## that ended the game, at death, madness or when time ran out. The watcher listens to GameStore
## (`view_changed`, and the `gameOver` event, which is followed by such a view) and to SceneRouter.
## It asks for `ending` as a terminal route ([method SceneRouterScript.goto_terminal]), so no back
## button or Escape pressed during the fade can displace it, and it counts the ending as shown only
## when SceneRouter actually mounted it (`screen_changed`). If the request was refused or failed,
## the next view, event or screen change asks again. Once shown, the player may open the case
## board on purpose; the watcher does not pull them back. A new session (OFFLINE) starts over.
## It decides nothing about the ending: the view says which one it is.
##
## Installed once on the scene root by bootstrap ([method install]), next to HorrorFx and the debug
## overlay, so it outlives SceneRouter screen changes. A terminal snapshot already in GameStore at
## install time is honoured as soon as the watcher is ready.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")

const NODE_NAME: String = "EndingWatcher"
const ENDING_SCREEN: StringName = &"ending"

var _store: GameStoreScript = null
var _router: SceneRouterScript = null
## True once SceneRouter mounted the ending of the current session.
var _shown: bool = false


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


## Asks [param router] for the `ending` screen as a terminal route unless it is already shown.
## Returns OK when a transition started, ERR_ALREADY_EXISTS when the ending is shown, ERR_BUSY when
## it is already on its way and ERR_UNCONFIGURED without a router.
static func open_ending(router: Node) -> Error:
	if not router is SceneRouterScript:
		return ERR_UNCONFIGURED
	var scene_router: SceneRouterScript = router as SceneRouterScript
	if scene_router.get_terminal_screen() == ENDING_SCREEN:
		return ERR_BUSY
	if scene_router.get_current_screen() == ENDING_SCREEN and not scene_router.is_transitioning():
		return ERR_ALREADY_EXISTS
	return scene_router.goto_terminal(ENDING_SCREEN)


func _ready() -> void:
	# The router first: a terminal snapshot already in the store is checked when the store binds.
	if _router == null:
		var router: Node = get_node_or_null(^"/root/SceneRouter")
		if router is SceneRouterScript:
			bind_router(router as SceneRouterScript)
	if _store == null:
		var autoload: Node = get_node_or_null(^"/root/GameStore")
		if autoload is GameStoreScript:
			bind_store(autoload as GameStoreScript)
	_check()


## Listens to [param store] instead of the GameStore autoload (tests pass their own store).
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.event_received.disconnect(_on_event_received)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	_shown = false
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.event_received.connect(_on_event_received)
		_store.connection_state_changed.connect(_on_connection_state_changed)
	_check()


## Uses [param router] instead of the SceneRouter autoload (tests pass their own router).
func bind_router(router: SceneRouterScript) -> void:
	if _router != null and is_instance_valid(_router):
		_router.screen_changed.disconnect(_on_screen_changed)
	_router = router
	if _router != null:
		_router.screen_changed.connect(_on_screen_changed)
	_check()


## True once the ending of the current session was actually mounted.
func has_shown_ending() -> bool:
	return _shown


func _check() -> void:
	if _shown or _store == null or _router == null or not _store.has_view():
		return
	if not _store.get_view().has("ending"):
		return
	if _router.get_current_screen() == ENDING_SCREEN and not _router.is_transitioning():
		_shown = true
		return
	if not _router.is_inside_tree():
		return
	open_ending(_router)


func _on_view_changed(_view: Dictionary, _state_version: int) -> void:
	_check()


func _on_event_received(event: Dictionary) -> void:
	if str(event.get("type", "")) == ProtocolConstants.EVENT_GAME_OVER:
		_check()


func _on_screen_changed(screen: StringName, _params: Dictionary) -> void:
	if screen == ENDING_SCREEN and _store != null and _store.get_view().has("ending"):
		_shown = true
	else:
		_check()


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.OFFLINE:
		_shown = false
