extends GutTest

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")
const ContractSupport = preload("res://tests/contract/contract_support.gd")
const HudScene = preload("res://src/scenes/hud/hud.tscn")
const HudScript = preload("res://src/scenes/hud/hud.gd")

var _backend: FakeBackend
var _store: GameStoreScript
var _hud: HudScript


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	_hud = HudScene.instantiate() as HudScript
	add_child_autofree(_hud)
	_hud.bind_store(_store)


func _fixture(name: String) -> Dictionary:
	var path: String = ContractSupport.fixtures_dir().path_join("views/%s.json" % name)
	var file: ContractSupport.JsonFile = ContractSupport.read_json(path)
	assert_eq(file.error, "", "fixture %s" % name)
	if file.data is Dictionary:
		return file.data
	return {}


func _text(unique_name: String) -> String:
	var label: Label = _hud.get_node("%" + unique_name) as Label
	return label.text


func _bar(unique_name: String) -> ProgressBar:
	return _hud.get_node("%" + unique_name) as ProgressBar


func _peer(desktop: String, phone: String) -> void:
	_backend.deliver(ProtocolConstants.MSG_PEER_STATUS, {"desktop": desktop, "phone": phone})


func _assert_all_missing() -> void:
	assert_eq(_text("ClockLabel"), "—")
	assert_eq(_text("PeriodLabel"), "—")
	assert_eq(_text("RemainingLabel"), "Осталось: —")
	assert_eq(_text("HealthLabel"), "Здоровье —")
	assert_eq(_text("SanityLabel"), "Рассудок —")
	assert_eq(_text("FatigueLabel"), "Усталость —")
	assert_eq(_text("StaticLabel"), "Static —")
	assert_eq(_text("PhoneLabel"), "Телефон: нет данных")
	assert_eq(_text("BatteryLabel"), "Заряд: —")


func test_without_a_view_every_value_is_a_dash() -> void:
	_assert_all_missing()
	assert_eq(_bar("HealthBar").value, 0.0)
	assert_false(_hud.is_time_rolling())


func test_shows_the_mid_fixture() -> void:
	assert_true(_store.set_view(_fixture("player-view.mid"), 1))

	assert_false(_hud.is_time_rolling(), "the first view is shown at once")
	assert_eq(_text("ClockLabel"), "День 2, 08:20")
	assert_eq(_text("PeriodLabel"), "Утро")
	assert_eq(_text("RemainingLabel"), "Осталось: 1 д 23 ч 40 мин")
	assert_eq(_text("HealthLabel"), "Здоровье 8/10")
	assert_eq(_text("SanityLabel"), "Рассудок 6/10")
	assert_eq(_text("FatigueLabel"), "Усталость 78%")
	assert_eq(_text("StaticLabel"), "Static 35%")
	assert_eq(_text("PhoneLabel"), "Телефон: в сети")
	assert_eq(_text("BatteryLabel"), "Заряд: 71%")
	assert_eq(_bar("HealthBar").value, 8.0)
	assert_eq(_bar("SanityBar").value, 6.0)
	assert_eq(_bar("FatigueBar").value, 78.0)
	assert_eq(_bar("StaticBar").value, 35.0)


func test_binding_shows_the_store_view_at_once() -> void:
	assert_true(_store.set_view(_fixture("player-view.end"), 3))
	var hud: HudScript = HudScene.instantiate() as HudScript
	hud.bind_store(_store)
	add_child_autofree(hud)

	var clock: Label = hud.get_node("%ClockLabel") as Label
	assert_eq(clock.text, "День 3, 18:10")
	var battery: Label = hud.get_node("%BatteryLabel") as Label
	assert_eq(battery.text, "Заряд: 12%")


func test_new_view_rolls_the_clock_and_time_left() -> void:
	assert_true(_store.set_view(_fixture("player-view.start"), 1))
	assert_true(_store.set_view(_fixture("player-view.end"), 2))

	assert_true(_hud.is_time_rolling())
	assert_eq(_text("ClockLabel"), "День 1, 08:00", "the roll starts at the previous clock")
	assert_eq(_text("PeriodLabel"), "Утро", "the period waits for the end of the roll")
	assert_eq(_text("HealthLabel"), "Здоровье 7/10", "vitals do not wait for the roll")
	assert_eq(_text("BatteryLabel"), "Заряд: 12%")

	_hud.show_clock_at(1440.0 + 2225.0)
	assert_eq(_text("ClockLabel"), "День 2, 13:05")
	assert_eq(_text("RemainingLabel"), "Осталось: 1 д 22 ч 55 мин")
	assert_eq(_text("PeriodLabel"), "Утро")

	_hud.finish_time_roll()
	assert_false(_hud.is_time_rolling())
	assert_eq(_text("ClockLabel"), "День 3, 18:10")
	assert_eq(_text("PeriodLabel"), "Вечер")
	assert_eq(_text("RemainingLabel"), "Осталось: 21 ч 50 мин")
	assert_eq(_hud.get_displayed_minute(), 3.0 * 1440.0 + 1090.0)


func test_roll_ends_by_itself_at_the_new_view() -> void:
	_hud.min_roll_seconds = 0.05
	_hud.max_roll_seconds = 0.05
	assert_true(_store.set_view(_fixture("player-view.start"), 1))
	assert_true(_store.set_view(_fixture("player-view.mid"), 2))
	assert_true(_hud.is_time_rolling())

	await wait_until(func() -> bool: return not _hud.is_time_rolling(), 2.0)

	assert_false(_hud.is_time_rolling())
	assert_eq(_text("ClockLabel"), "День 2, 08:20")
	assert_eq(_text("RemainingLabel"), "Осталось: 1 д 23 ч 40 мин")


func test_view_during_a_roll_continues_from_the_shown_time() -> void:
	assert_true(_store.set_view(_fixture("player-view.start"), 1))
	assert_true(_store.set_view(_fixture("player-view.mid"), 2))
	_hud.show_clock_at(1440.0 + 1210.0)
	assert_eq(_text("ClockLabel"), "День 1, 20:10")

	assert_true(_store.set_view(_fixture("player-view.end"), 3))

	assert_true(_hud.is_time_rolling())
	assert_eq(_hud.get_displayed_minute(), 1440.0 + 1210.0)
	assert_eq(_text("ClockLabel"), "День 1, 20:10")
	_hud.finish_time_roll()
	assert_eq(_text("ClockLabel"), "День 3, 18:10")


func test_clock_moving_back_is_shown_without_a_roll() -> void:
	assert_true(_store.set_view(_fixture("player-view.end"), 1))
	_backend.deliver(ProtocolConstants.MSG_RESYNC, {})
	assert_true(_store.set_view(_fixture("player-view.start"), 1))

	assert_false(_hud.is_time_rolling())
	assert_eq(_text("ClockLabel"), "День 1, 08:00")
	assert_eq(_text("PeriodLabel"), "Утро")


func test_view_outside_the_tree_is_shown_without_a_roll() -> void:
	assert_true(_store.set_view(_fixture("player-view.start"), 1))
	remove_child(_hud)

	assert_true(_store.set_view(_fixture("player-view.mid"), 2))

	assert_false(_hud.is_time_rolling())
	assert_eq(_text("ClockLabel"), "День 2, 08:20")
	add_child(_hud)


func test_partial_view_shows_dashes_for_absent_values() -> void:
	var view: Dictionary = {
		"clock": {"day": 2, "period": "night"},
		"vitals": {"health": 9, "sanity": "high"},
		"phone": {"paired": true},
	}
	assert_true(_store.set_view(view, 1))

	assert_eq(_text("ClockLabel"), "День 2")
	assert_eq(_text("PeriodLabel"), "Ночь")
	assert_eq(_text("RemainingLabel"), "Осталось: —")
	assert_eq(_text("HealthLabel"), "Здоровье 9/10")
	assert_eq(_text("SanityLabel"), "Рассудок —")
	assert_eq(_text("FatigueLabel"), "Усталость —")
	assert_eq(_text("StaticLabel"), "Static —")
	assert_eq(_text("PhoneLabel"), "Телефон: нет данных")
	assert_eq(_text("BatteryLabel"), "Заряд: —")
	assert_eq(_bar("SanityBar").value, 0.0)


func test_incomplete_clock_does_not_roll() -> void:
	assert_true(_store.set_view(_fixture("player-view.start"), 1))
	assert_true(_store.set_view({"clock": {"t": 60, "day": 1}, "static": 5}, 2))

	assert_false(_hud.is_time_rolling())
	assert_eq(_text("ClockLabel"), "День 1")
	assert_eq(_text("StaticLabel"), "Static 5%")


func test_peer_status_decides_the_phone_state() -> void:
	assert_true(_store.set_view(_fixture("player-view.mid"), 1))

	_peer("online", "offline")
	assert_eq(_text("PhoneLabel"), "Телефон: не в сети")
	assert_eq(_text("BatteryLabel"), "Заряд: 71%", "the last known charge stays visible")

	_peer("online", "unpaired")
	assert_eq(_text("PhoneLabel"), "Телефон: не привязан")
	assert_eq(_text("BatteryLabel"), "Заряд: —")

	_peer("online", "online")
	assert_eq(_text("PhoneLabel"), "Телефон: в сети")


func test_phone_state_from_the_view_before_peer_status() -> void:
	var view: Dictionary = _fixture("player-view.mid")
	view["phone"] = {"paired": false, "online": false, "battery": 0}
	assert_true(_store.set_view(view, 1))

	assert_eq(_text("PhoneLabel"), "Телефон: не привязан")
	assert_eq(_text("BatteryLabel"), "Заряд: —")


func test_ended_session_clears_the_hud() -> void:
	_backend.change_state(BackendScript.ConnectionState.ONLINE)
	assert_true(_store.set_view(_fixture("player-view.mid"), 1))
	_peer("online", "online")

	_backend.change_state(BackendScript.ConnectionState.OFFLINE)

	_assert_all_missing()


func test_rebinding_stops_following_the_old_store() -> void:
	var other: GameStoreScript = GameStoreScript.new()
	add_child_autofree(other)
	_hud.bind_store(other)

	assert_true(_store.set_view(_fixture("player-view.mid"), 1))

	_assert_all_missing()
