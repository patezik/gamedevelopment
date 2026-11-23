extends GutTest

const HudFormat = preload("res://src/scenes/hud/hud_format.gd")


func test_clock_text_shows_day_and_time() -> void:
	assert_eq(HudFormat.clock_text(2, "21:40"), "День 2, 21:40")
	assert_eq(HudFormat.clock_text(1, "08:00"), "День 1, 08:00")


func test_clock_text_shows_the_known_part_only() -> void:
	assert_eq(HudFormat.clock_text(3, ""), "День 3")
	assert_eq(HudFormat.clock_text(null, "07:05"), "07:05")
	assert_eq(HudFormat.clock_text(null, ""), HudFormat.MISSING)
	assert_eq(HudFormat.clock_text(3, "7:05"), "День 3", "a malformed clock face is not shown")


func test_parse_clock_accepts_only_hh_mm() -> void:
	assert_eq(HudFormat.parse_clock("00:00"), 0)
	assert_eq(HudFormat.parse_clock("21:40"), 21 * 60 + 40)
	assert_eq(HudFormat.parse_clock("23:59"), 1439)
	for bad: String in ["", "24:00", "12:60", "7:05", "+1:00", "12-00", "ab:cd", "12:000"]:
		assert_eq(HudFormat.parse_clock(bad), -1, bad)


func test_format_clock_pads_hours_and_minutes() -> void:
	assert_eq(HudFormat.format_clock(0), "00:00")
	assert_eq(HudFormat.format_clock(65), "01:05")
	assert_eq(HudFormat.format_clock(1439), "23:59")


func test_period_text_labels_protocol_periods() -> void:
	assert_eq(HudFormat.period_text("morning"), "Утро")
	assert_eq(HudFormat.period_text("day"), "День")
	assert_eq(HudFormat.period_text("evening"), "Вечер")
	assert_eq(HudFormat.period_text("night"), "Ночь")
	assert_eq(HudFormat.period_text(""), HudFormat.MISSING)
	assert_eq(HudFormat.period_text("dusk"), HudFormat.MISSING)


func test_duration_text_formats_days_hours_and_minutes() -> void:
	assert_eq(HudFormat.duration_text(0), "0 мин")
	assert_eq(HudFormat.duration_text(-5), "0 мин")
	assert_eq(HudFormat.duration_text(40), "40 мин")
	assert_eq(HudFormat.duration_text(65), "1 ч 05 мин")
	assert_eq(HudFormat.duration_text(1440), "1 д 0 ч 00 мин")
	assert_eq(HudFormat.duration_text(2860), "1 д 23 ч 40 мин")
	assert_eq(HudFormat.duration_text(4320), "3 д 0 ч 00 мин")


func test_remaining_text_needs_an_int() -> void:
	assert_eq(HudFormat.remaining_text(1310), "Осталось: 21 ч 50 мин")
	assert_eq(HudFormat.remaining_text(null), "Осталось: —")
	assert_eq(HudFormat.remaining_text("1310"), "Осталось: —")


func test_absolute_minute_orders_clock_faces() -> void:
	assert_eq(HudFormat.absolute_minute(0, "00:00"), 0)
	assert_eq(HudFormat.absolute_minute(1, "08:00"), 1440 + 480)
	assert_eq(HudFormat.absolute_minute(2, "00:10"), 2 * 1440 + 10)
	assert_true(HudFormat.absolute_minute(1, "23:50") < HudFormat.absolute_minute(2, "00:10"))
	assert_eq(HudFormat.absolute_minute(null, "08:00"), -1)
	assert_eq(HudFormat.absolute_minute(-1, "08:00"), -1)
	assert_eq(HudFormat.absolute_minute(1, ""), -1)


func test_split_minute_inverts_absolute_minute() -> void:
	assert_eq(HudFormat.split_minute(2 * 1440 + 10), Vector2i(2, 10))
	assert_eq(HudFormat.split_minute(1440 + 1430), Vector2i(1, 1430))
	assert_eq(HudFormat.split_minute(0), Vector2i(0, 0))
	assert_eq(HudFormat.split_minute(HudFormat.absolute_minute(3, "18:10")), Vector2i(3, 1090))


func test_read_int_accepts_whole_numbers_only() -> void:
	var source: Dictionary = {
		"int": 7, "float": 78.0, "fraction": 7.5, "text": "7", "flag": true, "nan": NAN
	}
	var read: Dictionary = {}
	for key: String in ["int", "float", "fraction", "text", "flag", "nan", "absent"]:
		read[key] = HudFormat.read_int(source, key)
	assert_eq(read, {
		"int": 7,
		"float": 78,
		"fraction": null,
		"text": null,
		"flag": null,
		"nan": null,
		"absent": null,
	})
	assert_true(read["float"] is int, "a whole float becomes an int")


func test_scale_and_percent_text() -> void:
	assert_eq(HudFormat.scale_text(8, 10), "8/10")
	assert_eq(HudFormat.scale_text(0, 10), "0/10")
	assert_eq(HudFormat.scale_text(null, 10), HudFormat.MISSING)
	assert_eq(HudFormat.percent_text(78), "78%")
	assert_eq(HudFormat.percent_text(null), HudFormat.MISSING)


func test_phone_state_prefers_live_peer_status() -> void:
	var paired_online: Dictionary = {"paired": true, "online": true, "battery": 71}
	assert_eq(HudFormat.phone_state("offline", paired_online), "offline")
	assert_eq(HudFormat.phone_state("unpaired", paired_online), "unpaired")
	assert_eq(HudFormat.phone_state("online", {}), "online")


func test_phone_state_falls_back_to_the_view() -> void:
	assert_eq(HudFormat.phone_state("unknown", {"paired": true, "online": true}), "online")
	assert_eq(HudFormat.phone_state("unknown", {"paired": true, "online": false}), "offline")
	assert_eq(HudFormat.phone_state("unknown", {"paired": false, "online": false}), "unpaired")
	assert_eq(HudFormat.phone_state("unknown", {"paired": true}), "unknown")
	assert_eq(HudFormat.phone_state("unknown", {}), "unknown")


func test_phone_and_battery_text() -> void:
	assert_eq(HudFormat.phone_text("online"), "Телефон: в сети")
	assert_eq(HudFormat.phone_text("offline"), "Телефон: не в сети")
	assert_eq(HudFormat.phone_text("unpaired"), "Телефон: не привязан")
	assert_eq(HudFormat.phone_text("unknown"), "Телефон: нет данных")
	assert_eq(HudFormat.battery_text({"battery": 12}, "offline"), "Заряд: 12%")
	assert_eq(HudFormat.battery_text({"battery": 12}, "unpaired"), "Заряд: —")
	assert_eq(HudFormat.battery_text({}, "online"), "Заряд: —")
