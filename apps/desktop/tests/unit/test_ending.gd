extends GutTest
## Ending (godot-client.md §4.5, ENG-006): the six endings on fixtures, their texts, what the
## accusation proved, the TruthRecap only from `ending.recap`, the seed row and the statistics.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const EndingScene = preload("res://src/scenes/ending/ending.tscn")
const Ending = preload("res://src/scenes/ending/ending.gd")
const EndingFixtures = preload("res://src/scenes/ending/ending_fixtures.gd")
const EndingFormat = preload("res://src/scenes/ending/ending_format.gd")

const TITLES: Dictionary = {
	"solved": "Дело раскрыто",
	"partial": "За недостатком улик",
	"wrong_accusation": "Ложное обвинение",
	"time_up": "Время вышло",
	"death": "Гибель",
	"madness": "Сигнал победил",
}

var _backend: FakeBackend
var _store: GameStoreScript


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)


func _screen(params: Dictionary) -> Ending:
	var screen: Ending = EndingScene.instantiate() as Ending
	screen.set_params(params)
	screen.bind_store(_store)
	add_child_autofree(screen)
	return screen


func _live(view: Dictionary) -> Ending:
	assert_true(_store.set_view(view, 1), "the store accepts the view")
	return _screen({})


func test_all_six_endings_render_on_fixtures() -> void:
	assert_eq(EndingFormat.ENDING_IDS.size(), 6)
	for ending_id: String in EndingFormat.ENDING_IDS:
		var view: Dictionary = EndingFixtures.view_for(ending_id)
		assert_false(view.is_empty(), "fixture of %s loads" % ending_id)
		var screen: Ending = _live(view)
		var texts: PackedStringArray = screen.get_texts()
		assert_eq(screen.get_ending_id(), ending_id)
		assert_has(texts, str(TITLES[ending_id]), "%s shows its title" % ending_id)
		assert_has(texts, EndingFormat.kind_text(ending_id), "%s shows its kind" % ending_id)
		assert_has(texts, str((view["ending"] as Dictionary)["text"]), "%s shows its text" % ending_id)
		assert_true(screen.has_recap(), "%s shows the TruthRecap" % ending_id)
		assert_has(texts, "sanatorium-42")
		assert_has(texts, "Статистика")
		assert_false(screen.is_preview())
		screen.free()
		_store.reset()


func test_each_ending_has_a_preview() -> void:
	for ending_id: String in EndingFormat.ENDING_IDS:
		var screen: Ending = _screen({"preview": ending_id})
		assert_true(screen.is_preview())
		assert_eq(screen.get_ending_id(), ending_id)
		assert_string_contains(screen.get_status_text(), ending_id)
		screen.free()


func test_run_on_its_own_previews_solved() -> void:
	var screen: Ending = EndingScene.instantiate() as Ending
	screen.bind_store(_store)
	add_child_autofree(screen)
	assert_eq(screen.get_ending_id(), "solved")


func test_proven_parts_only_for_an_accusation_ending() -> void:
	var partial: PackedStringArray = _live(EndingFixtures.view_for("partial")).get_texts()
	assert_has(partial, "Мотив: доказан")
	assert_has(partial, "Средство: не доказан")
	assert_has(partial, "Возможность: доказан")
	_store.reset()
	var time_up: PackedStringArray = _live(EndingFixtures.view_for("time_up")).get_texts()
	for text: String in time_up:
		assert_false(text.begins_with("Мотив:"), "time_up proves nothing")


func test_truth_recap_comes_from_the_ending_only() -> void:
	var view: Dictionary = EndingFixtures.view_for("solved")
	var recap: Dictionary = (view["ending"] as Dictionary)["recap"]
	var texts: PackedStringArray = _live(view).get_texts()
	assert_has(texts, "Что произошло на самом деле")
	assert_has(texts, str(recap["summary"]))
	assert_has(texts, "Ответственны: Доктор Белов")


func test_ending_without_recap_says_so() -> void:
	var view: Dictionary = EndingFixtures.view_for("death").duplicate(true)
	(view["ending"] as Dictionary).erase("recap")
	var screen: Ending = _live(view)
	assert_false(screen.has_recap())
	assert_has(screen.get_texts(), "Разбор истины недоступен.")


func test_no_recap_before_the_game_is_over() -> void:
	var screen: Ending = _live(PreviewFixtures.load_view("mid"))
	assert_eq(screen.get_ending_id(), "")
	assert_false(screen.has_recap())
	assert_string_contains(screen.get_status_text(), "не окончена")
	assert_does_not_have(screen.get_texts(), "Seed")
	for text: String in screen.get_texts():
		assert_false(text.begins_with("Ответственны"), "nothing names the responsible before the end")


func test_statistics_come_from_the_final_view() -> void:
	var view: Dictionary = EndingFixtures.view_for("solved")
	var rows: Dictionary = {}
	for row: PackedStringArray in EndingFormat.statistics_rows(view):
		rows[row[0]] = row[1]
	assert_eq(str(rows["Seed"]), "sanatorium-42")
	assert_eq(str(rows["Сценарий"]), "sanatorium_winter")
	assert_eq(str(rows["Конец игры"]), "День 3, 18:10")
	assert_eq(str(rows["Прошло игрового времени"]), "2 д 2 ч 10 мин")
	assert_eq(str(rows["Оставалось времени"]), "21 ч 50 мин")
	assert_eq(str(rows["Найдено улик"]), "5")
	assert_eq(str(rows["Улик сохранено на телефоне"]), "4")
	assert_eq(str(rows["Услышано показаний"]), "0")
	assert_eq(str(rows["Здоровье"]), "7/10")
	assert_eq(str(rows["Рассудок"]), "4/10")
	var screen: Ending = _live(view)
	assert_has(screen.get_texts(), "2 д 2 ч 10 мин")


func test_statistics_columns_keep_readable_width_at_laptop_resolution() -> void:
	var screen: Ending = _live(EndingFixtures.view_for("solved"))
	screen.set_anchors_preset(Control.PRESET_TOP_LEFT)
	screen.size = Vector2(1366, 768)
	await get_tree().process_frame
	await get_tree().process_frame
	var stats: GridContainer = screen.find_child("Statistics", true, false) as GridContainer
	var title: Label = stats.get_child(0) as Label
	assert_gt(title.size.x, 200.0, "the heading must not wrap into single letters")
	assert_eq(title.get_line_count(), 1)
	for child: Node in stats.get_children():
		if child is Label and (child as Label).text == "sanatorium-42":
			assert_gt((child as Label).size.x, 200.0, "the value column keeps its share of width")
			assert_eq((child as Label).get_line_count(), 1)


func test_timeline_shows_actual_time_location_participants_and_text_in_order() -> void:
	var texts: PackedStringArray = _live(EndingFixtures.view_for("solved")).get_texts()
	var first: String = "За 20 мин до начала · Процедурная · Доктор Белов — Ключ взят."
	var second: String = "Начало расследования · Оранжерея · Доктор Белов, Нина Орлова — Состоялась встреча."
	assert_has(texts, "Хронология")
	assert_has(texts, first)
	assert_has(texts, second)
	assert_true(texts.find(first) < texts.find(second))


func test_empty_timeline_clears_event_rows_and_keeps_the_final_seed() -> void:
	var screen: Ending = _live(EndingFixtures.view_for("solved"))
	assert_has(screen.get_texts(), "Хронология")
	var empty_view: Dictionary = EndingFixtures.view_for("time_up").duplicate(true)
	var ending: Dictionary = empty_view["ending"]
	var recap: Dictionary = ending["recap"]
	recap["timeline"] = []
	ending["seed"] = "empty-timeline-42"

	assert_true(_store.set_view(empty_view, 2))
	var texts: PackedStringArray = screen.get_texts()
	assert_eq(screen.get_ending_id(), "time_up")
	assert_true(screen.has_recap())
	assert_has(texts, "Ответственны: Доктор Белов")
	assert_has(texts, "empty-timeline-42")
	assert_does_not_have(texts, "Хронология")
	assert_does_not_have(texts, "За 20 мин до начала · Процедурная · Доктор Белов — Ключ взят.")
	assert_does_not_have(texts, "sanatorium-42")


func test_final_seed_and_timeline_clear_when_a_new_game_arrives() -> void:
	var screen: Ending = _live(EndingFixtures.view_for("solved"))
	assert_has(screen.get_texts(), "sanatorium-42")
	assert_true(_store.set_view(PreviewFixtures.load_view("start"), 2))
	assert_does_not_have(screen.get_texts(), "sanatorium-42")
	assert_does_not_have(screen.get_texts(), "Seed")
	assert_does_not_have(screen.get_texts(), "Хронология")
	assert_false(screen.has_recap())


func test_older_ending_without_seed_or_timeline_is_rendered() -> void:
	var view: Dictionary = EndingFixtures.view_for("solved").duplicate(true)
	var ending: Dictionary = view["ending"]
	ending.erase("seed")
	ending.erase("scenarioId")
	(ending["recap"] as Dictionary).erase("timeline")
	var screen: Ending = _live(view)
	assert_true(screen.has_recap())
	assert_has(screen.get_texts(), EndingFormat.SEED_UNAVAILABLE_TEXT)
	assert_does_not_have(screen.get_texts(), "Хронология")


func test_empty_seed_is_distinguished_from_an_omitted_seed() -> void:
	var view: Dictionary = EndingFixtures.view_for("solved").duplicate(true)
	(view["ending"] as Dictionary)["seed"] = ""
	assert_has(_live(view).get_texts(), "(пустая строка)")


func test_endings_that_force_vitals_or_time_show_them() -> void:
	var death: Dictionary = {}
	for row: PackedStringArray in EndingFormat.statistics_rows(EndingFixtures.view_for("death")):
		death[row[0]] = row[1]
	assert_eq(str(death["Здоровье"]), "0/10")
	var madness: Dictionary = {}
	for row: PackedStringArray in EndingFormat.statistics_rows(EndingFixtures.view_for("madness")):
		madness[row[0]] = row[1]
	assert_eq(str(madness["Рассудок"]), "0/10")
	var time_up: Dictionary = {}
	for row: PackedStringArray in EndingFormat.statistics_rows(EndingFixtures.view_for("time_up")):
		time_up[row[0]] = row[1]
	assert_eq(str(time_up["Оставалось времени"]), "0 мин")


func test_view_with_server_only_fields_is_not_shown() -> void:
	var screen: Ending = _screen({})
	var view: Dictionary = EndingFixtures.view_for("solved").duplicate(true)
	view["truth"] = {"culpritIds": ["ch_doctor"]}
	screen.call(&"_show", view)
	assert_push_error("server-only field 'truth'")
	assert_eq(screen.get_ending_id(), "")
	assert_false(screen.has_recap())


func test_live_view_replaces_the_preview_and_unknown_ids_are_rejected() -> void:
	var screen: Ending = _screen({"preview": "solved"})
	assert_true(_store.set_view(EndingFixtures.view_for("madness"), 3))
	assert_false(screen.is_preview())
	assert_eq(screen.get_ending_id(), "madness")
	assert_eq(EndingFixtures.view_for("victory"), {})
	assert_eq(EndingFormat.ending_id({"endingId": "victory"}), "")
