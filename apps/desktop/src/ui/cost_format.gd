extends RefCounted
## Text of an action's `costPreview` ("15 мин", "20–30 мин") and the confirmation threshold.
##
## Display only: the cost comes from the server (time-system.md §3); the client neither computes
## nor corrects it. A preview that is not `{ min, max }` with whole minutes and min <= max is
## shown as unknown and treated as long, so the player confirms before spending unknown time.

const UNIT: String = "мин"
const RANGE_DASH: String = "–"
const UNKNOWN_TEXT: String = "время неизвестно"
## An action whose upper bound reaches this many game minutes asks for confirmation.
const LONG_ACTION_MINUTES: int = 60
## Returned by [method bounds] for a preview that cannot be shown.
const INVALID: Vector2i = Vector2i(-1, -1)


## "15 мин" for a fixed cost, "20–30 мин" for a range, [constant UNKNOWN_TEXT] otherwise.
static func format_cost(preview: Variant) -> String:
	var cost: Vector2i = bounds(preview)
	if cost == INVALID:
		return UNKNOWN_TEXT
	if cost.x == cost.y:
		return "%d %s" % [cost.x, UNIT]
	return "%d%s%d %s" % [cost.x, RANGE_DASH, cost.y, UNIT]


## "15 мин" for a single duration in whole minutes (an exit's travel time); empty if invalid.
static func format_minutes(value: Variant) -> String:
	var minutes: int = whole_minutes(value)
	return "" if minutes < 0 else "%d %s" % [minutes, UNIT]


## True when the action may take [constant LONG_ACTION_MINUTES] or more, or its cost is unknown.
static func is_long(preview: Variant) -> bool:
	var cost: Vector2i = bounds(preview)
	return cost == INVALID or cost.y >= LONG_ACTION_MINUTES


## (min, max) in whole minutes, or [constant INVALID].
static func bounds(preview: Variant) -> Vector2i:
	if not preview is Dictionary:
		return INVALID
	var source: Dictionary = preview
	var low: int = whole_minutes(source.get("min"))
	var high: int = whole_minutes(source.get("max"))
	if low < 0 or high < low:
		return INVALID
	return Vector2i(low, high)


## A non-negative whole number of minutes (JSON numbers arrive as float), or -1.
static func whole_minutes(value: Variant) -> int:
	if value is int:
		var number: int = value
		return number if number >= 0 else -1
	if value is float:
		var real: float = value
		if is_finite(real) and real >= 0.0 and real == floorf(real) and real <= 2147483647.0:
			return int(real)
	return -1
