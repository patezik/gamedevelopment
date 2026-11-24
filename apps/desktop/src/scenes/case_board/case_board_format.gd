extends RefCounted
## Text and value mapping for the case board, built only from values the PlayerView carries.
##
## Presentation only (ADR 0002): the server decides what the player knows, which statements
## contradict what and who is a person of interest. Here the board picks labels, turns game minutes
## into a clock face using the clock the same view reports, and maps the player's suspicion level
## between the two forms of the protocol.

const HudFormat = preload("res://src/scenes/hud/hud_format.gd")

## Suspicion levels in protocol order (`SuspicionView.level`, `SUSPICION_LEVELS` of @hs/core).
## The `markSuspicion` action carries the level as a non-negative int (protocol.md §4); the board
## sends the index of the level in this list: 0 — none, 1 — possible, 2 — prime.
const SUSPICION_LEVELS: Array[String] = ["none", "possible", "prime"]
const LEVEL_NONE: String = "none"
const LEVEL_LABELS: Dictionary = {
	"none": "Нет",
	"possible": "Возможно",
	"prime": "Главный",
}
const KIND_LABELS: Dictionary = {
	"physical": "Предмет",
	"document": "Документ",
	"digital": "Цифровая",
	"testimonial": "Свидетельство",
}
const KIND_FALLBACK: String = "Улика"
const UNKNOWN_TIME: String = "время неизвестно"


## The int `markSuspicion.level` for a `SuspicionView.level` string; -1 for an unknown level.
static func level_code(level: String) -> int:
	return SUSPICION_LEVELS.find(level)


## The `SuspicionView.level` string for an int level; an empty string for an unknown code.
static func level_name(code: int) -> String:
	if code < 0 or code >= SUSPICION_LEVELS.size():
		return ""
	return SUSPICION_LEVELS[code]


## A known level as is; anything else the view may carry counts as no mark.
static func normalize_level(level: Variant) -> String:
	if level is String and SUSPICION_LEVELS.has(level):
		return level
	return LEVEL_NONE


static func level_text(level: String) -> String:
	return str(LEVEL_LABELS.get(level, LEVEL_LABELS[LEVEL_NONE]))


static func kind_text(kind: Variant) -> String:
	return str(KIND_LABELS.get(kind, KIND_FALLBACK)) if kind is String else KIND_FALLBACK


## The game minute where day 0, 00:00 lies, from the view's own clock: `clock.t` is the same moment
## as the clock face `clock.day`, `clock.time`. Null when the clock is absent or malformed.
static func clock_origin(clock: Dictionary) -> Variant:
	var t: Variant = HudFormat.read_int(clock, "t")
	var face: int = HudFormat.absolute_minute(
		HudFormat.read_int(clock, "day"), HudFormat.read_string(clock, "time")
	)
	if not t is int or face < 0:
		return null
	return (t as int) - face


## "День 1, 09:35" for game minute [param minute] given [param origin] from [method clock_origin];
## "минута 95" without a clock; [constant UNKNOWN_TIME] for a value that is not a whole minute.
static func minute_text(minute: Variant, origin: Variant) -> String:
	var value: Variant = whole_minute(minute)
	if value == null:
		return UNKNOWN_TIME
	if not origin is int:
		return "минута %d" % [value]
	var face: Vector2i = HudFormat.split_minute((value as int) - (origin as int))
	return HudFormat.clock_text(face.x, HudFormat.format_clock(face.y))


## "День 1, 08:00 — День 1, 20:40" or a single moment when [param to] is absent.
static func interval_text(from: Variant, to: Variant, origin: Variant) -> String:
	var start: String = minute_text(from, origin)
	if whole_minute(to) == null:
		return start
	return "%s — %s" % [start, minute_text(to, origin)]


## The JSON number [param value] as an int (JSON numbers arrive as floats), or null.
static func whole_minute(value: Variant) -> Variant:
	return HudFormat.read_int({"v": value}, "v")
