extends RefCounted
## Pure helpers of the Ending screen: what of the PlayerView it shows and in which words.
##
## Everything comes from the server: the ending and its text (`ending`), the parts the accusation
## proved (`ending.proven`) and the TruthRecap (`ending.recap`), which the server adds only to an
## ended game (ENG-006). The statistics are counts and values the same final view already carries
## (`clock`, `caseBoard`, `vitals`); nothing is computed from the truth or by game rules.

const HudFormat = preload("res://src/scenes/hud/hud_format.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

## The six endings of game-design.md §5 (ENDING_IDS of @hs/protocol).
const ENDING_IDS: Array[String] = ["solved", "partial", "wrong_accusation", "time_up", "death", "madness"]
## A short label of each ending, shown above the server's title.
const ENDING_KIND_TEXT: Dictionary = {
	"solved": "Раскрытие",
	"partial": "Неполное раскрытие",
	"wrong_accusation": "Ложное обвинение",
	"time_up": "Время вышло",
	"death": "Гибель",
	"madness": "Безумие",
}
const PART_TEXT: Dictionary = {
	"motive": "Мотив",
	"means": "Средство",
	"opportunity": "Возможность",
}
const PROVEN_TEXT: String = "доказан"
const NOT_PROVEN_TEXT: String = "не доказан"
const MISSING: String = "—"
## The protocol has no seed in any view (EndingView included); see godot-client.md §4.5.
const SEED_UNAVAILABLE_TEXT: String = "не передаётся сервером"


## The `ending` of [param view]; empty when the game is not over.
static func ending_of(view: Dictionary) -> Dictionary:
	return HudFormat.read_dict(view, "ending")


## A known ending id of [param ending], or an empty string.
static func ending_id(ending: Dictionary) -> String:
	var value: String = HudFormat.read_string(ending, "endingId")
	return value if ENDING_IDS.has(value) else ""


static func kind_text(ending_id_value: String) -> String:
	return str(ENDING_KIND_TEXT.get(ending_id_value, MISSING))


## `[[label, value], ...]` for the parts the accusation proved; empty without `proven`.
static func proven_rows(ending: Dictionary) -> Array[PackedStringArray]:
	var rows: Array[PackedStringArray] = []
	var proven: Dictionary = HudFormat.read_dict(ending, "proven")
	if proven.is_empty():
		return rows
	for part: String in ["motive", "means", "opportunity"]:
		var value: Variant = proven.get(part)
		var text: String = MISSING
		if value is bool:
			text = PROVEN_TEXT if (value as bool) else NOT_PROVEN_TEXT
		rows.append(PackedStringArray([str(PART_TEXT[part]), text]))
	return rows


## The TruthRecap: `{"summary": String, "responsible": Array[String] of names}`; empty when the
## view carries none.
static func recap_of(ending: Dictionary) -> Dictionary:
	var recap: Dictionary = HudFormat.read_dict(ending, "recap")
	if recap.is_empty():
		return {}
	var names: Array[String] = []
	var responsible: Variant = recap.get("responsible")
	if responsible is Array:
		for entry: Variant in responsible as Array:
			if entry is Dictionary:
				var person: Dictionary = entry
				var name: String = HudFormat.read_string(person, "name")
				names.append(name if not name.is_empty() else HudFormat.read_string(person, "id"))
	return {"summary": HudFormat.read_string(recap, "summary"), "responsible": names}


## `[[label, value], ...]` of the run's statistics, from the final view.
static func statistics_rows(view: Dictionary, seed_text: String = "") -> Array[PackedStringArray]:
	var clock: Dictionary = HudFormat.read_dict(view, "clock")
	var board: Dictionary = HudFormat.read_dict(view, "caseBoard")
	var vitals: Dictionary = HudFormat.read_dict(view, "vitals")
	var elapsed: Variant = HudFormat.read_int(clock, "t")
	var remaining: Variant = HudFormat.read_int(clock, "remainingMinutes")
	var clues: Array = _array(board.get("clues"))
	var captured: int = 0
	for clue: Variant in clues:
		if clue is Dictionary and (clue as Dictionary).get("captured") == true:
			captured += 1
	return [
		PackedStringArray(["Seed", seed_text if not seed_text.is_empty() else SEED_UNAVAILABLE_TEXT]),
		PackedStringArray([
			"Конец игры",
			HudFormat.clock_text(HudFormat.read_int(clock, "day"), HudFormat.read_string(clock, "time")),
		]),
		PackedStringArray(["Прошло игрового времени", _duration(elapsed)]),
		PackedStringArray(["Оставалось времени", _duration(remaining)]),
		PackedStringArray(["Найдено улик", str(clues.size())]),
		PackedStringArray(["Улик сохранено на телефоне", str(captured)]),
		PackedStringArray(["Услышано показаний", str(_array(board.get("statements")).size())]),
		PackedStringArray(["Найдено противоречий", str(_array(board.get("contradictions")).size())]),
		PackedStringArray(["Персон интереса", str(_array(board.get("personsOfInterest")).size())]),
		PackedStringArray(["Здоровье", HudFormat.scale_text(HudFormat.read_int(vitals, "health"), 10)]),
		PackedStringArray(["Рассудок", HudFormat.scale_text(HudFormat.read_int(vitals, "sanity"), 10)]),
	]


static func _duration(minutes: Variant) -> String:
	return HudFormat.duration_text(minutes as int) if minutes is int else MISSING


static func _array(value: Variant) -> Array:
	if value is Array:
		return value
	return []
