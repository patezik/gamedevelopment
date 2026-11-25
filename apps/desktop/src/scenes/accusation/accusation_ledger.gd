extends Node
## AccusationLedger: what became of the one irreversible request of the current session, the
## `accuse` with `confirm: true` (ENG-006). It outlives the Accusation screen, so leaving and
## reopening the screen cannot clear an accusation whose outcome is not known.
##
## Outcomes ([enum Outcome]):
## - NONE — nothing irreversible is in flight; the player may accuse.
## - SENT — the request left; waiting for its `action.result` (matched by `requestId`).
## - EXECUTED — the server accepted it (`ok: true`); waiting for the next view, which tells whether
##   the game ended (`ending`) or went on (a first wrong accusation is forgiven).
## - UNKNOWN — the result can no longer be told: the connection dropped before `action.result`
##   (the gateway sends `action.result` outside the replayed stream, so a reconnect never brings
##   it back) or no result came in [member result_timeout_seconds]. The accusation may have been
##   executed. The ledger never lets the player send another one in this session: a later
##   `ending` resolves it; nothing in the current PlayerView can tell a forgiven accusation from a
##   lost request, so a new stateVersion is not taken as proof either way (see godot-client.md
##   §4.4 and the protocol gap recorded in PROTO-005).
## - ENDED — the view carries `ending`.
##
## A refusal (`ok: false` for our request) returns to NONE. A new session — the connection goes
## OFFLINE or the `sessionId` changes — returns to NONE and forgets the request: a late answer of
## the previous session cannot touch the new one. Nothing is ever re-sent automatically.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")

enum Outcome { NONE, SENT, EXECUTED, UNKNOWN, ENDED }

## The outcome changed (or an EXECUTED wait became stalled).
signal changed(outcome: Outcome)
## The server refused the accusation; the player may correct it and accuse again.
signal refused(code: String, message: String)
## The server executed the accusation and the next view has no `ending`: the game goes on.
signal continued

const NODE_NAME: String = "AccusationLedger"
const META_KEY: StringName = &"accusation_ledger"
const RESULT_TIMEOUT_SECONDS: float = 15.0
const VIEW_TIMEOUT_SECONDS: float = 10.0

## How long SENT waits for `action.result` before the outcome is UNKNOWN.
var result_timeout_seconds: float = RESULT_TIMEOUT_SECONDS
## How long EXECUTED waits for a view before [method is_stalled] (the screen then unlocks its way
## back; a new accusation still waits for that view).
var view_timeout_seconds: float = VIEW_TIMEOUT_SECONDS

var _store: GameStoreScript = null
var _outcome: Outcome = Outcome.NONE
var _request_id: String = ""
var _session_id: String = ""
var _file: Dictionary = {}
var _elapsed: float = 0.0
var _stalled: bool = false


## The ledger under [param root] bound to [param store], created (and added deferred) if missing.
static func of(root: Node, store: GameStoreScript) -> Node:
	if root == null:
		return null
	var ledger: Node = root.get_node_or_null(NodePath(NODE_NAME))
	# A ledger created this frame is not in the tree yet (it is added deferred): the root's meta
	# finds it, so two screens of one frame never get two ledgers.
	if ledger == null and root.has_meta(META_KEY):
		var pending: Variant = root.get_meta(META_KEY)
		if pending is Node and is_instance_valid(pending as Node):
			ledger = pending as Node
	if ledger == null:
		ledger = (load("res://src/scenes/accusation/accusation_ledger.gd") as GDScript).new() as Node
		ledger.name = NODE_NAME
		root.set_meta(META_KEY, ledger)
		root.add_child.call_deferred(ledger)
	if ledger.call(&"get_store") != store:
		ledger.call(&"bind_store", store)
	return ledger


func _process(delta: float) -> void:
	advance(delta)


## Listens to [param store] and forgets any request of the previous store.
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		_store.view_changed.disconnect(_on_view_changed)
		_store.action_resolved.disconnect(_on_action_resolved)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	_reset(false)
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.action_resolved.connect(_on_action_resolved)
		_store.connection_state_changed.connect(_on_connection_state_changed)
		if _store.has_view() and _store.get_view().has("ending"):
			_set_outcome(Outcome.ENDED)


func get_store() -> GameStoreScript:
	return _store


func get_outcome() -> Outcome:
	_check_session()
	return _outcome


## True when a new accusation may be sent in this session.
func can_accuse() -> bool:
	return get_outcome() == Outcome.NONE


## True when EXECUTED waited [member view_timeout_seconds] without a view.
func is_stalled() -> bool:
	return _stalled


## The case file of the request in flight or with an unknown outcome; empty otherwise.
func get_file() -> Dictionary:
	return _file.duplicate(true)


func get_request_id() -> String:
	return _request_id


## Records that `accuse` with `confirm: true` for [param file] left as [param request_id].
## Refused (false) unless the outcome is NONE.
func begin(file: Dictionary, request_id: String) -> bool:
	if not can_accuse() or request_id.is_empty() or _store == null:
		return false
	_file = file.duplicate(true)
	_request_id = request_id
	_session_id = _store.get_session_id()
	_set_outcome(Outcome.SENT)
	return true


## Moves the timeouts on by [param delta] seconds (called every frame; tests call it directly).
func advance(delta: float) -> void:
	if _outcome == Outcome.SENT:
		_elapsed += delta
		if _elapsed >= result_timeout_seconds:
			_set_outcome(Outcome.UNKNOWN)
	elif _outcome == Outcome.EXECUTED and not _stalled:
		_elapsed += delta
		if _elapsed >= view_timeout_seconds:
			_stalled = true
			changed.emit(_outcome)


func _on_action_resolved(request_id: String, ok: bool, code: String, message: String) -> void:
	if not _check_session() or request_id != _request_id or _request_id.is_empty():
		return
	if _outcome != Outcome.SENT and _outcome != Outcome.UNKNOWN:
		return
	if ok:
		# Executed: the next view on this connection is the state after it.
		_set_outcome(Outcome.EXECUTED)
	else:
		_reset(true)
		refused.emit(code, message)


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	if not _check_session():
		return
	if view.has("ending"):
		_set_outcome(Outcome.ENDED)
	elif _outcome == Outcome.EXECUTED:
		# Only a view after an accepted result is proof that the game went on.
		_reset(true)
		continued.emit()


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.OFFLINE:
		# The session is over or replaced.
		_reset(_outcome != Outcome.NONE)
	elif state != BackendScript.ConnectionState.ONLINE and _outcome == Outcome.SENT:
		# The result of the request cannot come over the next connection.
		_set_outcome(Outcome.UNKNOWN)
	elif state == BackendScript.ConnectionState.ONLINE:
		_check_session()


## False (after forgetting everything) when the store is in another session than the request.
func _check_session() -> bool:
	if _outcome == Outcome.NONE or _store == null:
		return true
	var current: String = _store.get_session_id()
	if current.is_empty() or current == _session_id:
		return true
	_reset(true)
	return false


func _set_outcome(outcome: Outcome) -> void:
	_outcome = outcome
	_elapsed = 0.0
	_stalled = false
	if outcome == Outcome.ENDED or outcome == Outcome.NONE:
		_request_id = ""
		_file = {}
	changed.emit(outcome)


func _reset(notify: bool) -> void:
	_outcome = Outcome.NONE
	_request_id = ""
	_session_id = ""
	_file = {}
	_elapsed = 0.0
	_stalled = false
	if notify:
		changed.emit(_outcome)
