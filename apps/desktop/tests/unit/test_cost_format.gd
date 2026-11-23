extends GutTest

const CostFormat = preload("res://src/ui/cost_format.gd")


func test_fixed_cost_is_shown_in_minutes() -> void:
	assert_eq(CostFormat.format_cost({"min": 15, "max": 15}), "15 мин")


func test_range_uses_an_en_dash() -> void:
	assert_eq(CostFormat.format_cost({"min": 20, "max": 30}), "20–30 мин")


func test_json_numbers_parsed_as_float_are_whole_minutes() -> void:
	var parsed: Variant = JSON.parse_string("{\"min\": 25, \"max\": 38}")
	assert_eq(CostFormat.format_cost(parsed), "25–38 мин")


func test_zero_cost_is_shown() -> void:
	assert_eq(CostFormat.format_cost({"min": 0, "max": 0}), "0 мин")


func test_long_costs_stay_in_minutes() -> void:
	assert_eq(CostFormat.format_cost({"min": 150, "max": 150}), "150 мин")


func test_invalid_previews_are_shown_as_unknown() -> void:
	var invalid: Array = [
		null,
		"15",
		{},
		{"min": 15},
		{"min": 30, "max": 20},
		{"min": -5, "max": 5},
		{"min": 1.5, "max": 2},
		{"min": "10", "max": "20"},
	]
	for preview: Variant in invalid:
		assert_eq(CostFormat.format_cost(preview), CostFormat.UNKNOWN_TEXT, str(preview))
		assert_eq(CostFormat.bounds(preview), CostFormat.INVALID, str(preview))


func test_long_action_threshold_uses_the_upper_bound() -> void:
	assert_false(CostFormat.is_long({"min": 59, "max": 59}))
	assert_true(CostFormat.is_long({"min": 60, "max": 60}))
	assert_true(CostFormat.is_long({"min": 25, "max": 60}), "a range that may reach the threshold")
	assert_false(CostFormat.is_long({"min": 25, "max": 38}))


func test_unknown_cost_asks_for_confirmation() -> void:
	assert_true(CostFormat.is_long(null))
	assert_true(CostFormat.is_long({"min": 10, "max": 5}))


func test_format_minutes_for_travel_time() -> void:
	assert_eq(CostFormat.format_minutes(2), "2 мин")
	assert_eq(CostFormat.format_minutes(4.0), "4 мин")
	assert_eq(CostFormat.format_minutes(-1), "")
	assert_eq(CostFormat.format_minutes(null), "")
