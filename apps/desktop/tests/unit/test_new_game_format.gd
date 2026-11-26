extends GutTest

const Format = preload("res://src/scenes/new_game/new_game_format.gd")


func test_server_origin_prefers_params_then_command_line_then_default() -> void:
	var args: PackedStringArray = ["--server=http://10.0.0.5:7499/"]
	assert_eq(Format.server_origin({"server": "http://pc.local:7000"}, args), "http://pc.local:7000")
	assert_eq(Format.server_origin({}, args), "http://10.0.0.5:7499")
	assert_eq(Format.server_origin({}, PackedStringArray()), Format.DEFAULT_ORIGIN)
	assert_eq(Format.server_origin({"server": "ftp://x"}, PackedStringArray(["--server=bad"])), Format.DEFAULT_ORIGIN)


func test_the_bundled_server_comes_after_explicit_origins_and_before_the_default() -> void:
	var bundled: String = "http://127.0.0.1:7421"
	var args: PackedStringArray = ["--server=http://10.0.0.5:7499/"]
	assert_eq(Format.server_origin({}, PackedStringArray(), bundled), bundled)
	assert_eq(Format.server_origin({}, args, bundled), "http://10.0.0.5:7499")
	assert_eq(Format.server_origin({"server": "http://pc.local:7000"}, args, bundled), "http://pc.local:7000")
	assert_eq(Format.server_origin({}, PackedStringArray(), "bad"), Format.DEFAULT_ORIGIN)
	assert_eq(Format.explicit_origin({}, PackedStringArray()), "")
	assert_eq(Format.explicit_origin({}, args), "http://10.0.0.5:7499")


func test_origin_accepts_http_origins_only() -> void:
	assert_true(Format.is_origin("http://127.0.0.1:7420"))
	assert_true(Format.is_origin("https://host"))
	for value: String in ["127.0.0.1:7420", "http://h:0", "http://h:65536", "http://h:7420/api", "", "http://"]:
		assert_false(Format.is_origin(value), value)


func test_scenarios_keep_valid_unique_entries_in_server_order() -> void:
	var parsed: Array[Dictionary] = Format.parse_scenarios([
		{"id": "b", "title": " Санаторий ", "durationMinutes": 4320.0},
		{"id": "a", "title": "Усадьба", "durationMinutes": 90},
		{"id": "b", "title": "duplicate", "durationMinutes": 60.0},
		{"id": "", "title": "x", "durationMinutes": 60.0},
		{"id": "c", "title": "", "durationMinutes": 60.0},
		{"id": "d", "title": "x", "durationMinutes": 0.0},
		{"id": "e", "title": "x", "durationMinutes": 1.5},
		"junk",
	])
	assert_eq(parsed.size(), 2)
	assert_eq(parsed[0], {"id": "b", "title": "Санаторий", "minutes": 4320})
	var second: Dictionary = parsed[1]
	assert_eq(str(second.get("id")), "a")
	assert_eq(Format.parse_scenarios({"id": "a"}).size(), 0)
	assert_eq(Format.parse_scenarios(null).size(), 0)


func test_scenario_label_shows_the_duration() -> void:
	assert_eq(Format.scenario_label({"title": "Санаторий", "minutes": 4320}), "Санаторий · 72 ч игрового времени")
	assert_eq(Format.scenario_label({"title": "Т", "minutes": 90}), "Т · 1 ч 30 мин игрового времени")


func test_seed_follows_the_server_schema() -> void:
	for seed: String in ["winter-42", "A_b-9", "x", "a".repeat(64)]:
		assert_true(Format.is_valid_seed(seed), seed)
	for seed: String in ["", "a".repeat(65), "seed#1", "with space", "кириллица", "a\n"]:
		assert_false(Format.is_valid_seed(seed), seed)


func test_random_seed_is_left_to_the_server() -> void:
	var random: Dictionary = JSON.parse_string(Format.request_body("sanatorium_winter", ""))
	assert_eq(random, {"scenarioId": "sanatorium_winter"})
	var entered: Dictionary = JSON.parse_string(Format.request_body("sanatorium_winter", "winter-42"))
	assert_eq(entered, {"scenarioId": "sanatorium_winter", "seed": "winter-42"})


func test_create_errors_map_to_player_text() -> void:
	var error: Callable = func(code: String) -> Dictionary: return {"error": {"code": code, "message": "m"}}
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_CANT_CONNECT, 0, null), Format.CREATE_UNREACHABLE)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_TIMEOUT, 0, null), Format.CREATE_UNREACHABLE)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 404, error.call("SCENARIO_NOT_FOUND")), Format.CREATE_SCENARIO_GONE)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 422, error.call("GENERATION_UNSOLVABLE")), Format.CREATE_UNSOLVABLE)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 400, error.call("INVALID_MESSAGE")), Format.CREATE_INVALID)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 413, error.call("INVALID_MESSAGE")), Format.CREATE_INVALID)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 500, error.call("INTERNAL")), Format.CREATE_INTERNAL)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 404, {"message": "Route not found"}), Format.CREATE_INVALID)
	assert_eq(Format.create_error_text(HTTPRequest.RESULT_SUCCESS, 200, {}), Format.CREATE_BAD_ANSWER)


func test_catalog_errors_name_the_server() -> void:
	assert_eq(
		Format.catalog_error_text(HTTPRequest.RESULT_CANT_CONNECT, 0, "http://h:1"),
		Format.CATALOG_UNREACHABLE % "http://h:1"
	)
	assert_eq(Format.catalog_error_text(HTTPRequest.RESULT_SUCCESS, 500, "x"), Format.CATALOG_FAILED % 500)


func test_error_code_reads_the_rest_error_format_only() -> void:
	assert_eq(Format.error_code({"error": {"code": "X", "message": ""}}), "X")
	assert_eq(Format.error_code({"error": "X"}), "")
	assert_eq(Format.error_code({"message": "Not Found", "error": "Not Found", "statusCode": 404}), "")
	assert_eq(Format.error_code(null), "")
