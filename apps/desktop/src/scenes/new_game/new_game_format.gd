extends RefCounted
## NewGame data rules without a scene: the server address, the scenario list, the seed, the
## `POST /sessions` body and the player-facing text for each REST failure (backend.md §3).

const Envelope = preload("res://src/net/envelope.gd")

## The Session Server on this computer with the default HS_PORT.
const DEFAULT_ORIGIN: String = "http://127.0.0.1:7420"
## `--server=http://host:port` after `--` on the Godot command line overrides the default.
const SERVER_ARGUMENT: String = "--server="
## Seed accepted by the server (Seed in apps/server/src/routes/generation.ts).
const SEED_PATTERN: String = r"^[A-Za-z0-9_-]{1,64}\z"
const SEED_MAX_LENGTH: int = 64
const ORIGIN_PATTERN: String = r"^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?\z"

const CATALOG_UNREACHABLE: String = "Сервер игры недоступен по адресу %s. Запустите его и повторите."
const CATALOG_FAILED: String = "Не удалось получить список сценариев (HTTP %d)."
const CATALOG_EMPTY: String = "На сервере нет доступных сценариев."
const LAUNCH_FAILED: String = "Не удалось запустить сервер игры. Перезапустите игру; если ошибка повторится, сохраните лог игры."
const SEED_INVALID: String = "Seed: от 1 до 64 символов — латинские буквы, цифры, «-» и «_»."
const CREATE_UNREACHABLE: String = "Сервер не ответил. Проверьте, что он запущен, и повторите."
const CREATE_INVALID: String = "Сервер отклонил запрос. Проверьте seed и повторите."
const CREATE_SCENARIO_GONE: String = "Сценарий больше недоступен. Список сценариев обновлён."
const CREATE_UNSOLVABLE: String = "Для этого seed не удалось построить разрешимое дело. Выберите другой seed или случайный."
const CREATE_INTERNAL: String = "Внутренняя ошибка сервера. Повторите попытку."
const CREATE_BAD_ANSWER: String = "Сервер прислал неожиданный ответ. Повторите попытку."


## The server origin from `params.server`, then the command line, then [param bundled] (the port
## ServerLauncher actually started the packaged server on), then [constant DEFAULT_ORIGIN].
## An invalid value is skipped.
static func server_origin(
	params: Dictionary, user_args: PackedStringArray, bundled: String = ""
) -> String:
	var explicit: String = explicit_origin(params, user_args)
	if not explicit.is_empty():
		return explicit
	if is_origin(bundled):
		return bundled
	return DEFAULT_ORIGIN


## A valid origin from `params.server` or `--server=`, or "" when neither names one.
static func explicit_origin(params: Dictionary, user_args: PackedStringArray) -> String:
	var from_params: String = str(params.get("server", "")).strip_edges().trim_suffix("/")
	if is_origin(from_params):
		return from_params
	for argument: String in user_args:
		if argument.begins_with(SERVER_ARGUMENT):
			var value: String = argument.substr(SERVER_ARGUMENT.length()).strip_edges().trim_suffix("/")
			if is_origin(value):
				return value
	return ""


static func is_origin(value: String) -> bool:
	var found: RegExMatch = RegEx.create_from_string(ORIGIN_PATTERN).search(value)
	if found == null:
		return false
	var port: String = found.get_string(1).trim_prefix(":")
	return port.is_empty() or (port.to_int() >= 1 and port.to_int() <= 65535)


## Valid entries of `GET /scenarios` (`[{id, title, durationMinutes}]`) in server order; an entry
## of another shape or a repeated id is dropped. Not an array → empty.
static func parse_scenarios(body: Variant) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if not body is Array:
		return result
	var seen: Dictionary = {}
	for item: Variant in body as Array:
		if not item is Dictionary:
			continue
		var entry: Dictionary = item
		var id: Variant = entry.get("id")
		var title: Variant = entry.get("title")
		var minutes: int = Envelope.counter(entry.get("durationMinutes"))
		if not id is String or (id as String).is_empty() or (id as String).length() > 64:
			continue
		if not title is String or (title as String).strip_edges().is_empty() or minutes <= 0:
			continue
		if seen.has(id):
			continue
		seen[id] = true
		result.append({"id": id, "title": (title as String).strip_edges(), "minutes": minutes})
	return result


## "Санаторий · 72 ч игрового времени".
static func scenario_label(scenario: Dictionary) -> String:
	var minutes: int = scenario.get("minutes", 0) as int
	var hours: int = minutes / 60
	var duration: String = ("%d ч" % hours) if minutes % 60 == 0 else ("%d ч %d мин" % [hours, minutes % 60])
	return "%s · %s игрового времени" % [str(scenario.get("title", "")), duration]


static func is_valid_seed(seed: String) -> bool:
	return RegEx.create_from_string(SEED_PATTERN).search(seed) != null


## The `POST /sessions` body. An empty [param seed] leaves the choice to the server, which never
## returns it (a random seed stays hidden). A non-empty [param locale] (`ru`/`en`, QA-003) is the
## language of the game texts; the server falls back to ru for a scenario without such templates.
static func request_body(scenario_id: String, seed: String, locale: String = "") -> String:
	var body: Dictionary = {"scenarioId": scenario_id}
	if not seed.is_empty():
		body["seed"] = seed
	if not locale.is_empty():
		body["locale"] = locale
	return JSON.stringify(body)


## `error.code` of a REST error answer `{error: {code, message}}`; empty for another shape.
static func error_code(body: Variant) -> String:
	if not body is Dictionary:
		return ""
	var error: Variant = (body as Dictionary).get("error")
	if not error is Dictionary:
		return ""
	var code: Variant = (error as Dictionary).get("code")
	return code if code is String else ""


static func catalog_error_text(result: int, status: int, origin: String) -> String:
	if result != HTTPRequest.RESULT_SUCCESS:
		return CATALOG_UNREACHABLE % origin
	return CATALOG_FAILED % status


## Text for a failed `POST /sessions`.
static func create_error_text(result: int, status: int, body: Variant) -> String:
	if result != HTTPRequest.RESULT_SUCCESS:
		return CREATE_UNREACHABLE
	var code: String = error_code(body)
	if status == 404 and code == "SCENARIO_NOT_FOUND":
		return CREATE_SCENARIO_GONE
	if status == 422 and code == "GENERATION_UNSOLVABLE":
		return CREATE_UNSOLVABLE
	if status >= 400 and status < 500:
		return CREATE_INVALID
	if status >= 500:
		return CREATE_INTERNAL
	return CREATE_BAD_ANSWER

