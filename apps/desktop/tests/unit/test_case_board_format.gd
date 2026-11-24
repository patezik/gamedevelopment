extends GutTest

const CaseBoardFormat = preload("res://src/scenes/case_board/case_board_format.gd")


func test_level_codes_follow_the_protocol_order() -> void:
	assert_eq(CaseBoardFormat.level_code("none"), 0)
	assert_eq(CaseBoardFormat.level_code("possible"), 1)
	assert_eq(CaseBoardFormat.level_code("prime"), 2)
	assert_eq(CaseBoardFormat.level_code("certain"), -1)
	for code: int in 3:
		assert_eq(CaseBoardFormat.level_code(CaseBoardFormat.level_name(code)), code)
	assert_eq(CaseBoardFormat.level_name(3), "")
	assert_eq(CaseBoardFormat.level_name(-1), "")


func test_unknown_level_counts_as_no_mark() -> void:
	assert_eq(CaseBoardFormat.normalize_level("prime"), "prime")
	assert_eq(CaseBoardFormat.normalize_level("certain"), "none")
	assert_eq(CaseBoardFormat.normalize_level(2), "none")
	assert_eq(CaseBoardFormat.normalize_level(null), "none")
	assert_eq(CaseBoardFormat.level_text("possible"), "Возможно")


func test_kind_labels() -> void:
	assert_eq(CaseBoardFormat.kind_text("document"), "Документ")
	assert_eq(CaseBoardFormat.kind_text("strange"), "Улика")
	assert_eq(CaseBoardFormat.kind_text(null), "Улика")


func test_minutes_use_the_clock_of_the_same_view() -> void:
	var origin: Variant = CaseBoardFormat.clock_origin({"t": 1460, "day": 2, "time": "08:20"})
	var origin_minute: int = origin if origin is int else 0
	assert_true(origin is int)
	assert_eq(origin_minute, -1920)
	assert_eq(CaseBoardFormat.minute_text(0, origin), "День 1, 08:00")
	assert_eq(CaseBoardFormat.minute_text(1460.0, origin), "День 2, 08:20")
	assert_eq(CaseBoardFormat.minute_text(-120, origin), "День 1, 06:00", "prehistory before the start")
	assert_eq(CaseBoardFormat.interval_text(0, 760, origin), "День 1, 08:00 — День 1, 20:40")
	assert_eq(CaseBoardFormat.interval_text(1300, null, origin), "День 2, 05:40")


func test_minutes_without_a_clock_or_value() -> void:
	assert_true(CaseBoardFormat.clock_origin({}) == null)
	assert_true(CaseBoardFormat.clock_origin({"t": 5, "day": 1, "time": "25:00"}) == null)
	assert_eq(CaseBoardFormat.minute_text(95, null), "минута 95")
	assert_eq(CaseBoardFormat.minute_text("95", -1920), CaseBoardFormat.UNKNOWN_TIME)
	assert_eq(CaseBoardFormat.minute_text(9.5, -1920), CaseBoardFormat.UNKNOWN_TIME)
