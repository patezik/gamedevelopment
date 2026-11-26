extends Node
## Tracks the unresolved `accuse` with `confirm: true` (ENG-006) for each game joined by this
## client. It outlives the screen and the connection. Only a correlated result and an ensuing view,
## a rejection, or an ending can resolve an attempt.
##
## Outcomes ([enum Outcome]):
## - NONE — nothing irreversible is in flight; the player may accuse.
## - SENT — the request left; waiting for its `action.result` (matched by `requestId`).
## - EXECUTED — the server accepted it (`ok: true`); waiting for the next view, which tells whether
##   the game ended (`ending`) or went on (a first wrong accusation is forgiven).
## - UNKNOWN — the result was lost: the connection dropped before `action.result` or none came in
##   [member result_timeout_seconds]. The accusation may have been executed, so the ledger never
##   lets the player send a new one meanwhile. On the next connection to the same game the ledger
##   sends the same accusation again under the same `operationId`; the server answers with the
##   stored outcome of that operation or runs it once (ADR 0022, PROTO-005). A timeout on a live
##   connection waits for the next reconnect.
## - ENDED — the view carries `ending`.
##
## A refusal (`ok: false` for our request) returns to NONE. Welcome's `sessionId` selects which
## attempt to show. A disconnect cannot discard an unresolved attempt, even if the player joins
## another game before returning. Only an UNKNOWN attempt is re-sent, and only after a reconnect.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const AccusationFormat = preload("res://src/scenes/accusation/accusation_format.gd")

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


class Attempt:
	var outcome: Outcome = Outcome.SENT
	var request_id: String
	## Stable across retries: the server runs an accusation with this ID at most once.
	var operation_id: String
	## `stateVersion` the server reported for the executed operation; -1 until known.
	var executed_version: int = -1
	var file: Dictionary
	var elapsed: float = 0.0
	var stalled: bool = false

	func _init(sent_file: Dictionary, sent_request_id: String, sent_operation_id: String) -> void:
		file = sent_file.duplicate(true)
		request_id = sent_request_id
		operation_id = sent_operation_id


var _store: GameStoreScript = null
var _session_id: String = ""
var _attempts: Dictionary[String, Attempt] = {}


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
		_store.operation_resolved.disconnect(_on_operation_resolved)
		_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	_attempts.clear()
	_session_id = ""
	if _store != null:
		_session_id = _store.get_session_id()
		_store.view_changed.connect(_on_view_changed)
		_store.action_resolved.connect(_on_action_resolved)
		_store.operation_resolved.connect(_on_operation_resolved)
		_store.connection_state_changed.connect(_on_connection_state_changed)


func get_store() -> GameStoreScript:
	return _store


func get_outcome() -> Outcome:
	if not _is_current_session():
		return Outcome.NONE
	if _store.get_view().has("ending"):
		return Outcome.ENDED
	var attempt: Attempt = _attempts.get(_session_id)
	return attempt.outcome if attempt != null else Outcome.NONE


## True when a new accusation may be sent in this session.
func can_accuse() -> bool:
	return _is_current_session() and get_outcome() == Outcome.NONE


## True when EXECUTED waited [member view_timeout_seconds] without a view.
func is_stalled() -> bool:
	var attempt: Attempt = _current_attempt()
	return attempt != null and attempt.stalled


## The case file of the request in flight or with an unknown outcome; empty otherwise.
func get_file() -> Dictionary:
	var attempt: Attempt = _current_attempt()
	return attempt.file.duplicate(true) if attempt != null else {}


func get_request_id() -> String:
	var attempt: Attempt = _current_attempt()
	return attempt.request_id if attempt != null else ""


## Records that `accuse` with `confirm: true` for [param file] left as [param request_id].
## Refused (false) unless the outcome is NONE.
func begin(file: Dictionary, request_id: String, operation_id: String = "") -> bool:
	if not can_accuse() or request_id.is_empty():
		return false
	_attempts[_session_id] = Attempt.new(file, request_id, operation_id)
	changed.emit(Outcome.SENT)
	return true


## Moves the timeouts on by [param delta] seconds (called every frame; tests call it directly).
func advance(delta: float) -> void:
	var attempt: Attempt = _current_attempt()
	if attempt == null:
		return
	if attempt.outcome == Outcome.SENT:
		attempt.elapsed += delta
		if attempt.elapsed >= result_timeout_seconds:
			_set_outcome(attempt, Outcome.UNKNOWN)
	elif attempt.outcome == Outcome.EXECUTED and not attempt.stalled:
		attempt.elapsed += delta
		if attempt.elapsed >= view_timeout_seconds:
			attempt.stalled = true
			changed.emit(Outcome.EXECUTED)


func _on_operation_resolved(request_id: String, state_version: int) -> void:
	var attempt: Attempt = _current_attempt()
	if attempt != null and request_id == attempt.request_id:
		attempt.executed_version = state_version


func _on_action_resolved(request_id: String, ok: bool, code: String, message: String) -> void:
	var attempt: Attempt = _current_attempt()
	if attempt == null or request_id != attempt.request_id:
		return
	if attempt.outcome != Outcome.SENT and attempt.outcome != Outcome.UNKNOWN:
		return
	if ok:
		# Executed: the next view on this connection is the state after it. A view that is already
		# at the version the operation produced (a retry after a reconnect) is that proof.
		if (
			attempt.executed_version >= 0
			and _store.get_state_version() >= attempt.executed_version
			and not _store.get_view().has("ending")
		):
			_attempts.erase(_session_id)
			changed.emit(Outcome.NONE)
			continued.emit()
		else:
			_set_outcome(attempt, Outcome.EXECUTED)
	else:
		_attempts.erase(_session_id)
		changed.emit(Outcome.NONE)
		refused.emit(code, message)


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	if not _is_current_session():
		return
	if view.has("ending"):
		if _attempts.erase(_session_id):
			changed.emit(Outcome.ENDED)
		return
	var attempt: Attempt = _current_attempt()
	if attempt != null and attempt.outcome == Outcome.EXECUTED:
		# Only a view after an accepted result is proof that the game went on.
		_attempts.erase(_session_id)
		changed.emit(Outcome.NONE)
		continued.emit()


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	if state == BackendScript.ConnectionState.ONLINE:
		var joined_id: String = _store.get_session_id()
		if joined_id != _session_id:
			_session_id = joined_id
			changed.emit(get_outcome())
		_retry_unknown()
		return
	# Backend clears its ID before emitting OFFLINE, so use the known ID of the lost connection.
	var attempt: Attempt = _attempts.get(_session_id)
	if attempt != null and attempt.outcome == Outcome.SENT:
		_set_outcome(attempt, Outcome.UNKNOWN)
	if state == BackendScript.ConnectionState.OFFLINE:
		_session_id = ""
		changed.emit(Outcome.NONE)


## Sends the accusation with the unknown outcome again under the same operation ID. The server
## answers with the stored outcome, or runs it once if the first request never arrived (ADR 0022).
func _retry_unknown() -> void:
	var attempt: Attempt = _current_attempt()
	if attempt == null or attempt.outcome != Outcome.UNKNOWN or attempt.operation_id.is_empty():
		return
	var action: Dictionary = AccusationFormat.accuse_action(attempt.file, true, attempt.operation_id)
	if _store.request_action(action) != OK:
		return
	attempt.request_id = _store.get_last_action_request_id()
	_set_outcome(attempt, Outcome.SENT)


func _is_current_session() -> bool:
	return _store != null and not _session_id.is_empty() and _store.get_session_id() == _session_id


func _current_attempt() -> Attempt:
	return _attempts.get(_session_id) if _is_current_session() else null


func _set_outcome(attempt: Attempt, outcome: Outcome) -> void:
	attempt.outcome = outcome
	attempt.elapsed = 0.0
	attempt.stalled = false
	changed.emit(outcome)
