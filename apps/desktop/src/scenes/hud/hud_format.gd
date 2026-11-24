extends RefCounted
## Text for the HUD built from PlayerView values exactly as the server sent them.
##
## Only presentation: reading JSON values safely, formatting minutes and percentages, choosing a
## label. No game rule lives here (ADR 0002): the server decides the clock, the period, the time
## left, the vitals and the phone state; a value that is absent or malformed is shown as
## [constant MISSING] instead of being guessed.

const GameStoreScript = preload("res://src/autoload/game_store.gd")

## Placeholder for a value the current view does not carry.
const MISSING: String = "—"
const MINUTES_PER_HOUR: int = 60
const MINUTES_PER_DAY: int = 1440
## Labels of the protocol `dayPeriod` values.
const PERIOD_LABELS: Dictionary = {
	"morning": "Утро",
	"day": "День",
	"evening": "Вечер",
	"night": "Ночь",
}
## Phone states the HUD shows: the `peer.status` values plus [constant GameStoreScript.PEER_UNKNOWN].
const PHONE_ONLINE: String = "online"
const PHONE_OFFLINE: String = "offline"
const PHONE_UNPAIRED: String = "unpaired"
const PHONE_LABELS: Dictionary = {
	"online": "в сети",
	"offline": "не в сети",
	"unpaired": "не привязан",
	"unknown": "нет данных",
}
## Upper bounds of the vitals scales (protocol PlayerView.vitals).
const HEALTH_MAX: int = 10
const SANITY_MAX: int = 10

const DIGITS: String = "0123456789"


## [param key] of [param source] as an int; JSON numbers arrive as floats, so a whole finite float
## counts too. Anything else (absent, fractional, a string, a bool) is null.
static func read_int(source: Dictionary, key: String) -> Variant:
	var value: Variant = source.get(key)
	if value is int:
		return value
	if value is float:
		var number: float = value
		if is_finite(number) and number == floorf(number):
			return int(number)
	return null


## [param key] of [param source] if it is a String, otherwise an empty string.
static func read_string(source: Dictionary, key: String) -> String:
	var value: Variant = source.get(key)
	if value is String:
		return value
	return ""


## [param key] of [param source] if it is a Dictionary, otherwise an empty one.
static func read_dict(source: Dictionary, key: String) -> Dictionary:
	var value: Variant = source.get(key)
	if value is Dictionary:
		return value
	return {}


## Minutes since midnight of a `HH:mm` clock face, or -1 if [param time] is not one.
static func parse_clock(time: String) -> int:
	if time.length() != 5 or time[2] != ":":
		return -1
	for index: int in [0, 1, 3, 4]:
		if not DIGITS.contains(time[index]):
			return -1
	var hours: int = time.substr(0, 2).to_int()
	var minutes: int = time.substr(3, 2).to_int()
	if hours > 23 or minutes > 59:
		return -1
	return hours * MINUTES_PER_HOUR + minutes


## `HH:mm` for [param minutes_of_day] in 0..1439.
static func format_clock(minutes_of_day: int) -> String:
	var hours: int = floori(float(minutes_of_day) / MINUTES_PER_HOUR)
	return "%02d:%02d" % [hours, minutes_of_day % MINUTES_PER_HOUR]


## "День 2, 21:40"; with only one of the parts known, that part; with none, [constant MISSING].
static func clock_text(day: Variant, time: String) -> String:
	var has_day: bool = day is int
	var has_time: bool = parse_clock(time) >= 0
	if has_day and has_time:
		return "День %d, %s" % [day, time]
	if has_day:
		return "День %d" % [day]
	if has_time:
		return time
	return MISSING


## The label of a `dayPeriod` value; [constant MISSING] for an absent or unknown one.
static func period_text(period: String) -> String:
	return str(PERIOD_LABELS.get(period, MISSING))


## A length of time: "1 д 23 ч 40 мин", "2 ч 05 мин", "40 мин"; a non-positive length is "0 мин".
static func duration_text(total_minutes: int) -> String:
	if total_minutes <= 0:
		return "0 мин"
	var days: int = floori(float(total_minutes) / MINUTES_PER_DAY)
	var hours: int = floori(float(total_minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR)
	var minutes: int = total_minutes % MINUTES_PER_HOUR
	if days > 0:
		return "%d д %d ч %02d мин" % [days, hours, minutes]
	if hours > 0:
		return "%d ч %02d мин" % [hours, minutes]
	return "%d мин" % [minutes]


## "Осталось: …" for the `remainingMinutes` the server reported, or with [constant MISSING].
static func remaining_text(remaining_minutes: Variant) -> String:
	if remaining_minutes is int:
		return "Осталось: %s" % duration_text(remaining_minutes as int)
	return "Осталось: %s" % MISSING


## A clock face the server sent (`day`, `HH:mm`) as minutes since the start of day 0, so two faces
## can be compared and blended while the HUD rolls from one to the other. -1 if [param day] is not
## a non-negative int or [param time] is not `HH:mm`.
static func absolute_minute(day: Variant, time: String) -> int:
	var minutes_of_day: int = parse_clock(time)
	if not day is int or (day as int) < 0 or minutes_of_day < 0:
		return -1
	return (day as int) * MINUTES_PER_DAY + minutes_of_day


## The inverse of [method absolute_minute] for a minute >= 0: x is the day, y the minutes since
## midnight.
static func split_minute(minute: int) -> Vector2i:
	return Vector2i(floori(float(minute) / MINUTES_PER_DAY), posmod(minute, MINUTES_PER_DAY))


## "8/10" for a value on a 0..[param maximum] scale, [constant MISSING] for a non-int.
static func scale_text(value: Variant, maximum: int) -> String:
	if value is int:
		return "%d/%d" % [value, maximum]
	return MISSING


## "78%" for an int percentage, [constant MISSING] otherwise.
static func percent_text(value: Variant) -> String:
	if value is int:
		return "%d%%" % [value]
	return MISSING


## The phone state to show. The live `peer.status` wins once the store has one; before that the
## `phone` block of the PlayerView decides; without either the state is unknown.
static func phone_state(peer_status: String, phone: Dictionary) -> String:
	if GameStoreScript.PHONE_STATUSES.has(peer_status):
		return peer_status
	var raw_paired: Variant = phone.get("paired")
	if not raw_paired is bool:
		return GameStoreScript.PEER_UNKNOWN
	var paired: bool = raw_paired
	if not paired:
		return PHONE_UNPAIRED
	var raw_online: Variant = phone.get("online")
	if not raw_online is bool:
		return GameStoreScript.PEER_UNKNOWN
	var online: bool = raw_online
	return PHONE_ONLINE if online else PHONE_OFFLINE


static func phone_text(state: String) -> String:
	return "Телефон: %s" % str(PHONE_LABELS.get(state, PHONE_LABELS[GameStoreScript.PEER_UNKNOWN]))


## "Заряд: 71%"; an unpaired phone or an absent value shows [constant MISSING].
static func battery_text(phone: Dictionary, state: String) -> String:
	if state == PHONE_UNPAIRED:
		return "Заряд: %s" % MISSING
	return "Заряд: %s" % percent_text(read_int(phone, "battery"))
