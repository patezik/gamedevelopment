extends GutTest

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const FakeRestBackend = preload("res://tests/unit/support/fake_rest_backend.gd")
const BASE_URL: String = "http://127.0.0.1:7420"
const SESSION_ID: String = "0b6f2c1e-5d1a-4c55-9a0f-2f0e5b1c7d11"
const TOKEN: String = "desktop-token-secret-42"
const SEED: String = "seed-12345"
const CULPRIT: String = "char_culprit_secret"
const EXPORT_DIR: String = "user://test_debug_repro"

var _backend: FakeRestBackend
var _store: GameStoreScript
var _overlay: DebugOverlay
var _copied: Array[String] = []


func before_each() -> void:
	_backend = FakeRestBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	_copied.clear()
	_overlay = _new_overlay(false)


func after_each() -> void:
	var directory: String = ProjectSettings.globalize_path(EXPORT_DIR)
	var access: DirAccess = DirAccess.open(directory)
	if access == null:
		return
	for file_name: String in access.get_files():
		access.remove(file_name)
	DirAccess.remove_absolute(directory)


func _new_overlay(release: bool) -> DebugOverlay:
	var overlay: DebugOverlay = DebugOverlay.new()
	overlay.bind_backend(_backend)
	overlay.bind_store(_store)
	overlay.export_directory = EXPORT_DIR
	overlay.clipboard_writer = func(text: String) -> void: _copied.append(text)
	if release:
		overlay.force_release_mode()
	add_child_autofree(overlay)
	watch_signals(overlay)
	return overlay


func _f12(pressed: bool = true, echo: bool = false) -> InputEventKey:
	var event: InputEventKey = InputEventKey.new()
	event.keycode = KEY_F12
	event.pressed = pressed
	event.echo = echo
	return event


func _truth_answer() -> Dictionary:
	return {
		"sessionId": SESSION_ID,
		"scenarioId": "sanatorium_winter",
		"seed": SEED,
		"generatorVersion": "0.1.0",
		"minute": 495.0,
		"truth": {"culpritIds": [CULPRIT], "crime": {"kind": "murder"}},
	}


func _export_answer() -> Dictionary:
	return {
		"format": "hollow-signal-repro",
		"version": 1.0,
		"exportedAt": "2026-11-24T10:00:00.000Z",
		"server": {"version": "0.0.0", "protocolVersion": 1.0},
		"session": {"id": SESSION_ID, "status": "active", "stateVersion": 7.0},
		"scenarioId": "sanatorium_winter",
		"seed": SEED,
		"generatorVersion": "0.1.0",
		"stateHash": "abc123",
		"snapshot": {"investigation": "{\"truth\":{}}", "minute": 495.0},
	}


func _attach() -> void:
	assert_eq(_overlay.attach_session(BASE_URL, SESSION_ID, TOKEN), OK)


func _receive_truth() -> void:
	_attach()
	assert_eq(_overlay.request_truth(), OK)
	_backend.answer(_backend.last_call().id, 200, _truth_answer())


func _tracked_texts() -> String:
	var texts: PackedStringArray = []
	for error: Variant in get_errors():
		texts.append(str((error as Object).call("to_s")))
	return "\n".join(texts)


func _handle_tracked_warnings() -> void:
	for error: Variant in get_errors():
		(error as Object).set("handled", true)


# --- opening and closing ---------------------------------------------------------------------

func test_f12_opens_and_closes_the_panel() -> void:
	assert_false(_overlay.is_open())

	_overlay._input(_f12())
	assert_true(_overlay.is_open())
	var panel: Control = _overlay.get_node("Panel") as Control
	assert_true(panel.visible)

	_overlay._input(_f12())
	assert_false(_overlay.is_open())
	assert_signal_emit_count(_overlay, "toggled", 2)


func test_released_or_repeated_f12_and_other_keys_do_not_toggle() -> void:
	_overlay._input(_f12(false))
	_overlay._input(_f12(true, true))
	var other: InputEventKey = InputEventKey.new()
	other.keycode = KEY_F11
	other.pressed = true
	_overlay._input(other)

	assert_false(_overlay.is_open())


func test_close_button_closes_the_panel() -> void:
	_overlay.open()
	var button: Button = _overlay.get_node("Panel").find_child("CloseButton", true, false) as Button
	button.pressed.emit()

	assert_false(_overlay.is_open())


# --- data shown ------------------------------------------------------------------------------

func test_panel_shows_time_and_state_version_from_game_store() -> void:
	assert_string_contains(_overlay.get_time_text(), DebugOverlay.NO_VALUE)
	assert_string_contains(_overlay.get_state_version_text(), DebugOverlay.NO_VALUE)

	_store.set_view({
		"clock": {"t": 510.0, "day": 1.0, "time": "08:30", "period": "morning", "remainingMinutes": 4170.0},
	}, 7)

	assert_string_contains(_overlay.get_time_text(), "08:30")
	assert_string_contains(_overlay.get_time_text(), "день 1")
	assert_string_contains(_overlay.get_time_text(), "t=510")
	assert_eq(_overlay.get_state_version_text(), "stateVersion: 7")


func test_truth_request_goes_to_the_debug_route_with_the_desktop_token() -> void:
	_attach()

	assert_eq(_overlay.request_truth(), OK)

	assert_eq(_backend.calls.size(), 1)
	var call: FakeRestBackend.Call = _backend.last_call()
	assert_eq(call.url, "%s/api/v1/sessions/%s/debug/truth" % [BASE_URL, SESSION_ID])
	assert_eq(call.method, HTTPClient.METHOD_GET)
	assert_eq(call.token, TOKEN)


func test_truth_answer_shows_seed_and_keeps_truth_hidden_until_revealed() -> void:
	_receive_truth()

	assert_eq(_overlay.get_seed(), SEED)
	assert_string_contains(_overlay.get_seed_text(), SEED)
	assert_string_contains(_overlay.get_seed_text(), "sanatorium_winter")
	assert_signal_emitted_with_parameters(_overlay, "request_finished", ["truth", true])
	var truth_view: TextEdit = _overlay.get_node("Panel").find_child("TruthView", true, false) as TextEdit
	assert_false(truth_view.visible)
	assert_eq(truth_view.text, "")

	_overlay.reveal_truth(true)

	assert_true(truth_view.visible)
	assert_string_contains(truth_view.text, CULPRIT)
	assert_false(truth_view.editable)


func test_copy_seed_puts_the_received_seed_on_the_clipboard() -> void:
	assert_eq(_overlay.copy_seed(), ERR_UNCONFIGURED)
	assert_eq(_copied.size(), 0)

	_receive_truth()
	assert_eq(_overlay.copy_seed(), OK)

	assert_eq(_copied.size(), 1)
	assert_eq(_copied[0], SEED)


func test_export_writes_the_repro_bundle_from_the_debug_route() -> void:
	_attach()

	assert_eq(_overlay.request_export(), OK)
	var call: FakeRestBackend.Call = _backend.last_call()
	assert_eq(call.url, "%s/api/v1/sessions/%s/debug/export" % [BASE_URL, SESSION_ID])
	assert_eq(call.token, TOKEN)
	_backend.answer(call.id, 200, _export_answer())

	assert_signal_emitted_with_parameters(_overlay, "request_finished", ["export", true])
	var path: String = _overlay.get_last_export_path()
	assert_string_ends_with(path, "repro-%s-v7.json" % SESSION_ID)
	assert_true(FileAccess.file_exists(path))
	var saved: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	assert_true(saved is Dictionary)
	var bundle: Dictionary = saved
	var saved_format: String = str(bundle.get("format"))
	var saved_seed: String = str(bundle.get("seed"))
	assert_eq(saved_format, "hollow-signal-repro")
	assert_eq(saved_seed, SEED)
	assert_eq(_overlay.get_seed(), SEED)


# --- failures --------------------------------------------------------------------------------

func test_404_reports_that_the_debug_api_is_disabled() -> void:
	_receive_truth()
	_overlay.reveal_truth(true)

	_overlay.request_truth()
	_backend.answer(_backend.last_call().id, 404, null)

	assert_string_contains(_overlay.get_status(), "HS_DEBUG_TRUTH")
	assert_eq(_overlay.get_truth_text(), "", "a failed request drops the truth shown before")
	assert_false(_overlay.is_truth_revealed())
	assert_signal_emitted_with_parameters(_overlay, "request_finished", ["truth", false])
	assert_push_warning("HTTP 404")


func test_404_on_export_writes_nothing() -> void:
	_attach()
	_overlay.request_export()
	_backend.answer(_backend.last_call().id, 404, {"error": {"code": "NOT_FOUND", "message": "x"}})

	assert_eq(_overlay.get_last_export_path(), "")
	assert_false(DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(EXPORT_DIR)))
	assert_string_contains(_overlay.get_status(), "404")
	assert_push_warning("HTTP 404")


func test_unauthorized_and_forbidden_are_reported_as_access_errors() -> void:
	for status: int in [401, 403]:
		_attach()
		_overlay.request_truth()
		_backend.answer(_backend.last_call().id, status, {"error": {"code": "UNAUTHORIZED", "message": "no"}})

		assert_string_contains(_overlay.get_status(), "Нет доступа")
		assert_string_contains(_overlay.get_status(), str(status))
		assert_eq(_overlay.get_seed(), "")
	assert_push_warning_count(2)
	_handle_tracked_warnings()


func test_network_failure_and_unexpected_body_are_reported() -> void:
	_attach()
	_overlay.request_truth()
	_backend.answer(_backend.last_call().id, 0, null, HTTPRequest.RESULT_CANT_CONNECT)
	assert_string_contains(_overlay.get_status(), "Сервер недоступен")

	_overlay.request_truth()
	_backend.answer(_backend.last_call().id, 200, {"truth": {}})
	assert_string_contains(_overlay.get_status(), "неожиданной формы")
	assert_eq(_overlay.get_seed(), "")
	assert_push_warning_count(2)
	_handle_tracked_warnings()


func test_failure_warnings_carry_neither_token_nor_truth() -> void:
	_receive_truth()
	_overlay.request_truth()
	_backend.answer(_backend.last_call().id, 403, {"error": {"code": "UNAUTHORIZED", "message": TOKEN}})
	_overlay.request_export()
	_backend.answer(_backend.last_call().id, 404, null)

	var logged: String = _tracked_texts()
	assert_ne(logged, "", "the failures are reported as warnings")
	assert_false(logged.contains(TOKEN))
	assert_false(logged.contains(CULPRIT))
	assert_false(logged.contains(SESSION_ID))
	_handle_tracked_warnings()


func test_no_request_without_a_session() -> void:
	assert_eq(_overlay.request_truth(), ERR_UNCONFIGURED)
	assert_eq(_overlay.request_export(), ERR_UNCONFIGURED)

	assert_eq(_backend.calls.size(), 0)
	assert_string_contains(_overlay.get_status(), "Нет сессии")


func test_attach_session_rejects_incomplete_credentials() -> void:
	assert_eq(_overlay.attach_session("127.0.0.1:7420", SESSION_ID, TOKEN), ERR_INVALID_PARAMETER)
	assert_eq(_overlay.attach_session(BASE_URL, " ", TOKEN), ERR_INVALID_PARAMETER)
	assert_eq(_overlay.attach_session(BASE_URL, SESSION_ID, ""), ERR_INVALID_PARAMETER)
	assert_false(_overlay.has_session())


func test_answers_to_other_requests_are_ignored() -> void:
	_attach()
	_backend.answer(999, 200, _truth_answer())

	assert_eq(_overlay.get_seed(), "")
	assert_signal_not_emitted(_overlay, "request_finished")


func test_late_answer_for_a_previous_session_is_dropped() -> void:
	_attach()
	_overlay.request_truth()
	var old_id: int = _backend.last_call().id
	assert_eq(_overlay.attach_session(BASE_URL, "other-session", "other-token"), OK)

	_backend.answer(old_id, 200, _truth_answer())

	assert_eq(_overlay.get_seed(), "")
	assert_eq(_overlay.get_truth_text(), "")


# --- release build ---------------------------------------------------------------------------

func test_tests_run_in_a_debug_build() -> void:
	assert_true(DebugOverlay.is_debug_build(), "GUT runs on an editor binary with the debug tag")
	assert_true(_overlay.is_available())


func test_release_mode_panel_is_unavailable_and_sends_nothing() -> void:
	var overlay: DebugOverlay = _new_overlay(true)

	assert_false(overlay.is_available())
	assert_null(overlay.get_node_or_null("Panel"), "no UI is built in release")
	overlay._input(_f12())
	assert_false(overlay.is_open())
	assert_false(overlay.open())
	assert_eq(overlay.attach_session(BASE_URL, SESSION_ID, TOKEN), ERR_UNAVAILABLE)
	assert_eq(overlay.request_truth(), ERR_UNAVAILABLE)
	assert_eq(overlay.request_export(), ERR_UNAVAILABLE)
	assert_eq(overlay.copy_seed(), ERR_UNAVAILABLE)
	assert_eq(_backend.calls.size(), 0, "no debug request in release")
	assert_false(overlay.is_processing_input())


func test_switching_to_release_drops_session_and_late_answers() -> void:
	_receive_truth()
	_overlay.open()
	_overlay.request_truth()
	var pending: int = _backend.last_call().id
	var sent: int = _backend.calls.size()

	_overlay.force_release_mode()
	_backend.answer(pending, 200, _truth_answer())

	assert_false(_overlay.is_open())
	assert_false(_overlay.has_session())
	assert_eq(_overlay.get_truth_text(), "")
	assert_eq(_overlay.get_seed(), "")
	assert_eq(_overlay.request_truth(), ERR_UNAVAILABLE)
	assert_eq(_backend.calls.size(), sent)


func test_install_adds_nothing_in_a_release_build() -> void:
	var host: Node = Node.new()
	add_child_autofree(host)

	assert_null(DebugOverlay._install_if(host, false))
	await wait_process_frames(1)

	assert_eq(host.get_child_count(), 0)


func test_install_adds_one_overlay_in_a_debug_build() -> void:
	var host: Node = Node.new()
	add_child_autofree(host)

	var first: DebugOverlay = DebugOverlay.install(host)
	await wait_process_frames(1)
	var second: DebugOverlay = DebugOverlay.install(host)

	assert_not_null(first)
	assert_eq(second, first)
	assert_eq(host.get_child_count(), 1)
	assert_eq(first.name, DebugOverlay.NODE_NAME)


# --- truth isolation -------------------------------------------------------------------------

func test_truth_never_reaches_game_store() -> void:
	watch_signals(_store)
	_store.set_view({"clock": {"time": "08:00", "day": 1.0}}, 3)
	var view_before: Dictionary = _store.get_view()

	_receive_truth()
	_overlay.reveal_truth(true)
	_overlay.request_export()
	_backend.answer(_backend.last_call().id, 200, _export_answer())

	assert_signal_emit_count(_store, "view_changed", 1, "only the set_view of this test")
	assert_eq(_store.get_state_version(), 3)
	assert_eq(_store.get_view(), view_before)
	assert_eq(GameStoreScript.find_forbidden_key(_store.get_view()), "")
	assert_false(JSON.stringify(_store.get_view()).contains(CULPRIT))


func test_closing_the_panel_drops_the_truth() -> void:
	_receive_truth()
	_overlay.open()
	_overlay.reveal_truth(true)

	_overlay.close()

	assert_eq(_overlay.get_truth_text(), "")
	assert_false(_overlay.is_truth_revealed())
	var truth_view: TextEdit = _overlay.get_node("Panel").find_child("TruthView", true, false) as TextEdit
	assert_eq(truth_view.text, "")
	assert_eq(_overlay.get_seed(), SEED, "the seed is not secret and stays")


func test_end_of_session_forgets_token_and_truth() -> void:
	_receive_truth()
	_overlay.request_truth()
	var pending: int = _backend.last_call().id

	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_backend.answer(pending, 200, _truth_answer())

	assert_false(_overlay.has_session())
	assert_eq(_overlay.get_truth_text(), "")
	assert_eq(_overlay.get_seed(), "")
	assert_eq(_overlay.request_truth(), ERR_UNCONFIGURED)
