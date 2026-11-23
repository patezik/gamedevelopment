extends GutTest

const DebugApi = preload("res://src/scenes/overlays/debug/debug_api.gd")


func test_endpoint_builds_only_the_two_existing_debug_routes() -> void:
	assert_eq(
		DebugApi.endpoint("http://127.0.0.1:7420/", "s-1", DebugApi.TRUTH),
		"http://127.0.0.1:7420/api/v1/sessions/s-1/debug/truth"
	)
	assert_eq(
		DebugApi.endpoint(" https://host:7420 ", "s-1", DebugApi.EXPORT),
		"https://host:7420/api/v1/sessions/s-1/debug/export"
	)
	assert_eq(DebugApi.endpoint("http://h", "s-1", "state"), "", "no other route")


func test_endpoint_encodes_the_session_id_and_rejects_bad_input() -> void:
	assert_eq(
		DebugApi.endpoint("http://h", "a/../b", DebugApi.TRUTH),
		"http://h/api/v1/sessions/a%2F..%2Fb/debug/truth"
	)
	assert_eq(DebugApi.endpoint("127.0.0.1:7420", "s-1", DebugApi.TRUTH), "")
	assert_eq(DebugApi.endpoint("http://", "s-1", DebugApi.TRUTH), "")
	assert_eq(DebugApi.endpoint("http://h", "", DebugApi.TRUTH), "")


func test_valid_answers_need_success_status_and_route_shape() -> void:
	var ok: int = HTTPRequest.RESULT_SUCCESS
	assert_true(DebugApi.is_valid_answer(DebugApi.TRUTH, ok, 200, {"seed": "1", "truth": {}}))
	assert_false(DebugApi.is_valid_answer(DebugApi.TRUTH, ok, 200, {"truth": {}}))
	assert_false(DebugApi.is_valid_answer(DebugApi.TRUTH, ok, 404, {"seed": "1", "truth": {}}))
	assert_false(DebugApi.is_valid_answer(DebugApi.TRUTH, HTTPRequest.RESULT_TIMEOUT, 200, {"seed": "1", "truth": {}}))
	var bundle: Dictionary = {"format": DebugApi.REPRO_FORMAT, "seed": "1", "snapshot": {}}
	assert_true(DebugApi.is_valid_answer(DebugApi.EXPORT, ok, 200, bundle))
	bundle["format"] = "other"
	assert_false(DebugApi.is_valid_answer(DebugApi.EXPORT, ok, 200, bundle))
	assert_false(DebugApi.is_valid_answer(DebugApi.EXPORT, ok, 200, null))


func test_failures_are_described_by_status() -> void:
	var ok: int = HTTPRequest.RESULT_SUCCESS
	assert_string_contains(DebugApi.describe_failure(ok, 404), "HS_DEBUG_TRUTH")
	assert_string_contains(DebugApi.describe_failure(ok, 401), "desktopToken")
	assert_string_contains(DebugApi.describe_failure(ok, 403), "Нет доступа")
	assert_string_contains(DebugApi.describe_failure(ok, 501), "501")
	assert_string_contains(DebugApi.describe_failure(ok, 500), "500")
	assert_string_contains(DebugApi.describe_failure(HTTPRequest.RESULT_CANT_CONNECT, 0), "недоступен")


func test_repro_file_name_is_safe() -> void:
	assert_eq(DebugApi.repro_file_name("s-1", 7), "repro-s-1-v7.json")
	assert_eq(DebugApi.repro_file_name("s-1", -1), "repro-s-1-v0.json")
	assert_false(DebugApi.repro_file_name("a/b:c", 1).contains("/"))
