extends GutTest

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")

var _backend: FakeBackend
var _store: GameStoreScript


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	watch_signals(_store)


func _view(time: String) -> Dictionary:
	return {"clock": {"time": time, "day": 1}, "inventory": [{"id": "it_flashlight"}]}


func _view_time(view: Dictionary) -> String:
	var clock: Dictionary = view.get("clock", {})
	return str(clock.get("time", ""))


func _last(signal_name: String) -> Array:
	var parameters: Array = get_signal_parameters(_store, signal_name)
	return parameters


func _last_failure_code() -> String:
	var code: String = _last("action_failed")[0]
	return code


func test_set_view_stores_view_and_emits_view_changed() -> void:
	assert_false(_store.has_view())
	assert_eq(_store.get_state_version(), -1)

	assert_true(_store.set_view(_view("08:00"), 1))

	assert_signal_emit_count(_store, "view_changed", 1)
	var parameters: Array = _last("view_changed")
	var emitted: Dictionary = parameters[0]
	assert_eq(_view_time(emitted), "08:00")
	var version: int = parameters[1]
	assert_eq(version, 1)
	assert_true(_store.has_view())
	assert_eq(_store.get_state_version(), 1)
	assert_eq(_view_time(_store.get_view()), "08:00")


func test_stored_view_is_a_read_only_copy() -> void:
	var view: Dictionary = _view("08:00")
	_store.set_view(view, 1)
	var clock: Dictionary = view["clock"]
	clock["time"] = "23:59"

	var stored: Dictionary = _store.get_view()
	var stored_clock: Dictionary = stored["clock"]
	var stored_inventory: Array = stored["inventory"]
	assert_eq(_view_time(stored), "08:00")
	assert_true(stored.is_read_only())
	assert_true(stored_clock.is_read_only())
	assert_true(stored_inventory.is_read_only())


func test_stale_state_version_is_ignored() -> void:
	_store.set_view(_view("09:00"), 5)

	assert_false(_store.set_view(_view("08:00"), 3))

	assert_signal_emit_count(_store, "view_changed", 1)
	assert_eq(_store.get_state_version(), 5)
	assert_eq(_view_time(_store.get_view()), "09:00")


func test_same_state_version_is_ignored() -> void:
	_store.set_view(_view("08:00"), 2)

	assert_false(_store.set_view(_view("08:30"), 2))

	assert_signal_emit_count(_store, "view_changed", 1)
	assert_eq(_view_time(_store.get_view()), "08:00")


func test_newer_state_version_replaces_view() -> void:
	_store.set_view(_view("08:00"), 2)

	assert_true(_store.set_view(_view("08:30"), 3))

	assert_signal_emit_count(_store, "view_changed", 2)
	assert_eq(_store.get_state_version(), 3)
	assert_eq(_view_time(_store.get_view()), "08:30")


func test_view_with_server_truth_is_rejected() -> void:
	var view: Dictionary = _view("08:00")
	view["caseBoard"] = {"testimonies": [{"id": "t1", "veracity": "lie"}]}

	assert_false(_store.set_view(view, 1))

	assert_push_error("veracity")
	assert_signal_not_emitted(_store, "view_changed")
	assert_false(_store.has_view())


func test_find_forbidden_key_checks_every_depth() -> void:
	assert_eq(GameStoreScript.find_forbidden_key({"a": [{"b": {"culpritIds": []}}]}), "culpritIds")
	assert_eq(GameStoreScript.find_forbidden_key({"truth": 1}), "truth")
	assert_eq(GameStoreScript.find_forbidden_key({"note": "the truth is out there"}), "")


func test_view_update_message_sets_view() -> void:
	# JSON numbers arrive as floats.
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 3.0, "view": _view("10:00")})

	assert_signal_emit_count(_store, "view_changed", 1)
	assert_eq(_store.get_state_version(), 3)
	assert_eq(_view_time(_store.get_view()), "10:00")


func test_stale_view_update_message_is_ignored() -> void:
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 4, "view": _view("10:00")})
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 2, "view": _view("09:00")})
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 4, "view": _view("09:30")})

	assert_signal_emit_count(_store, "view_changed", 1)
	assert_eq(_view_time(_store.get_view()), "10:00")


func test_view_update_with_invalid_version_is_ignored() -> void:
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 1.5, "view": _view("10:00")})

	assert_push_warning("stateVersion")
	assert_signal_not_emitted(_store, "view_changed")


func test_view_after_resync_replaces_state_whatever_its_version() -> void:
	_store.set_view(_view("10:00"), 10)

	_backend.deliver(ProtocolConstants.MSG_RESYNC, {"reason": "buffer_miss"})
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 1, "view": _view("10:05")})
	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 1, "view": _view("10:06")})

	assert_signal_emit_count(_store, "view_changed", 2)
	assert_eq(_store.get_state_version(), 1)
	assert_eq(_view_time(_store.get_view()), "10:05")


func test_event_message_emits_event_received() -> void:
	_backend.deliver(
		ProtocolConstants.MSG_EVENT,
		{"event": {"type": ProtocolConstants.EVENT_INCOMING_CALL, "callId": "call-1"}}
	)

	assert_signal_emit_count(_store, "event_received", 1)
	var event: Dictionary = _last("event_received")[0]
	assert_eq(str(event.get("type")), ProtocolConstants.EVENT_INCOMING_CALL)
	assert_eq(str(event.get("callId")), "call-1")
	assert_true(event.is_read_only())


func test_event_of_unknown_type_is_ignored() -> void:
	_backend.deliver(ProtocolConstants.MSG_EVENT, {"event": {"type": "explosion"}})

	assert_push_warning("unknown type")
	assert_signal_not_emitted(_store, "event_received")


func test_peer_status_message_emits_peer_status_changed_on_change() -> void:
	assert_eq(_store.get_phone_status(), GameStoreScript.PEER_UNKNOWN)

	_backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "unpaired"})
	_backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "unpaired"})

	assert_signal_emit_count(_store, "peer_status_changed", 1)
	assert_signal_emitted_with_parameters(_store, "peer_status_changed", ["online", "unpaired"])
	assert_eq(_store.get_desktop_status(), "online")
	assert_eq(_store.get_phone_status(), "unpaired")

	_backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "online"})

	assert_signal_emit_count(_store, "peer_status_changed", 2)
	assert_signal_emitted_with_parameters(_store, "peer_status_changed", ["online", "online"])


func test_peer_status_with_unknown_values_is_ignored() -> void:
	_backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "asleep"})

	assert_push_warning("peer.status")
	assert_signal_not_emitted(_store, "peer_status_changed")


func test_failed_action_result_emits_action_failed() -> void:
	_backend.deliver(
		ProtocolConstants.MSG_ACTION_RESULT,
		{
			"requestId": "desktop-3",
			"ok": false,
			"error": ProtocolConstants.ERROR_ACTION_BLOCKED,
			"minutesSpent": 0,
		}
	)

	assert_signal_emitted_with_parameters(
		_store, "action_failed", [ProtocolConstants.ERROR_ACTION_BLOCKED, ""]
	)


func test_successful_action_result_emits_nothing() -> void:
	_backend.deliver(
		ProtocolConstants.MSG_ACTION_RESULT, {"requestId": "desktop-3", "ok": true, "minutesSpent": 5}
	)

	assert_signal_not_emitted(_store, "action_failed")


func test_error_with_request_id_emits_action_failed() -> void:
	_backend.deliver(
		ProtocolConstants.MSG_ERROR,
		{"code": ProtocolConstants.ERROR_GAME_OVER, "message": "Game over", "requestId": "desktop-4"}
	)

	assert_signal_emitted_with_parameters(
		_store, "action_failed", [ProtocolConstants.ERROR_GAME_OVER, "Game over"]
	)
	assert_signal_not_emitted(_store, "error_received")


func test_error_without_request_id_emits_error_received() -> void:
	_backend.deliver(
		ProtocolConstants.MSG_ERROR,
		{"code": ProtocolConstants.ERROR_UNAUTHORIZED, "message": "Bad token"}
	)

	assert_signal_emitted_with_parameters(
		_store, "error_received", [ProtocolConstants.ERROR_UNAUTHORIZED, "Bad token"]
	)
	assert_signal_not_emitted(_store, "action_failed")


func test_request_action_sends_a_copy_through_backend() -> void:
	var action: Dictionary = {"type": ProtocolConstants.ACTION_WAIT, "minutes": 30}

	assert_eq(_store.request_action(action), OK)
	action["minutes"] = 60

	assert_eq(_backend.sent.size(), 1)
	assert_eq(_backend.sent[0], {"type": ProtocolConstants.ACTION_WAIT, "minutes": 30})
	assert_signal_not_emitted(_store, "action_failed")


func test_request_action_accepts_read_only_actions_from_the_view() -> void:
	_store.set_view({"availableActions": [{"action": {"type": "rest", "minutes": 120}}]}, 1)
	var available: Array = _store.get_view()["availableActions"]
	var entry: Dictionary = available[0]
	var action: Dictionary = entry["action"]

	assert_eq(_store.request_action(action), OK)

	assert_eq(_backend.sent.size(), 1)
	assert_false(_backend.sent[0].is_read_only())


func test_request_action_rejects_actions_outside_desktop_role() -> void:
	assert_eq(_store.request_action({"type": ProtocolConstants.ACTION_CALL}), ERR_INVALID_PARAMETER)
	assert_eq(_store.request_action({}), ERR_INVALID_PARAMETER)

	assert_signal_emit_count(_store, "action_failed", 2)
	assert_eq(_last_failure_code(), ProtocolConstants.ERROR_ACTION_INVALID)
	assert_eq(_backend.sent.size(), 0)


func test_request_action_without_connection_emits_action_failed() -> void:
	_backend.send_result = ERR_UNCONFIGURED

	var action: Dictionary = {"type": ProtocolConstants.ACTION_WAIT, "minutes": 5}

	assert_eq(_store.request_action(action), ERR_UNCONFIGURED)

	assert_eq(_last_failure_code(), GameStoreScript.ERROR_NOT_CONNECTED)


func test_request_action_without_backend_emits_action_failed() -> void:
	_store.bind_backend(null)

	var action: Dictionary = {"type": ProtocolConstants.ACTION_WAIT, "minutes": 5}

	assert_eq(_store.request_action(action), ERR_UNCONFIGURED)

	assert_eq(_last_failure_code(), GameStoreScript.ERROR_NOT_CONNECTED)


func test_connection_state_is_relayed() -> void:
	_backend.change_state(BackendScript.ConnectionState.CONNECTING)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_backend.change_state(BackendScript.ConnectionState.ONLINE)

	assert_signal_emit_count(_store, "connection_state_changed", 2)
	assert_signal_emitted_with_parameters(
		_store, "connection_state_changed", [BackendScript.ConnectionState.ONLINE]
	)
	assert_true(_store.is_online())
	assert_eq(_store.get_connection_state(), BackendScript.ConnectionState.ONLINE)


func test_retrying_keeps_the_view() -> void:
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_store.set_view(_view("08:00"), 2)

	_backend.change_state(BackendScript.ConnectionState.RETRYING)

	assert_false(_store.is_online())
	assert_true(_store.has_view())
	assert_eq(_store.get_state_version(), 2)


func test_offline_clears_the_session_state() -> void:
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_store.set_view(_view("08:00"), 7)
	_backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": "online", "phone": "online"})

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)

	assert_false(_store.has_view())
	assert_true(_store.get_view().is_empty())
	assert_signal_emitted_with_parameters(
		_store, "peer_status_changed", [GameStoreScript.PEER_UNKNOWN, GameStoreScript.PEER_UNKNOWN]
	)
	# A new session starts its versions again.
	assert_true(_store.set_view(_view("08:00"), 1))


func test_rebinding_backend_stops_listening_to_the_old_one() -> void:
	var other: FakeBackend = FakeBackend.new()
	add_child_autofree(other)
	_store.bind_backend(other)

	_backend.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 1, "view": _view("08:00")})
	assert_signal_not_emitted(_store, "view_changed")

	other.deliver(ProtocolConstants.MSG_VIEW_UPDATE, {"stateVersion": 1, "view": _view("08:00")})
	assert_signal_emit_count(_store, "view_changed", 1)
