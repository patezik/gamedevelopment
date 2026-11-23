extends RefCounted
## Addresses and answers of the server debug routes (SRV-009, backend.md §6) for the debug overlay.
##
## The routes exist only when the server runs with `HS_DEBUG_TRUTH=1` and accept only the
## session's desktop token; without the flag the server answers 404 as for any unknown path.
## This file builds no other route and keeps no state.

const TRUTH: String = "truth"
const EXPORT: String = "export"
const KINDS: Array[String] = [TRUTH, EXPORT]
## `format` of a repro bundle (apps/server/src/diagnostics/repro.ts).
const REPRO_FORMAT: String = "hollow-signal-repro"


## `GET <base>/api/v1/sessions/<id>/debug/<kind>`; an empty string if an argument is invalid.
static func endpoint(base_url: String, session_id: String, kind: String) -> String:
	if not KINDS.has(kind) or not is_base_url(base_url) or session_id.strip_edges().is_empty():
		return ""
	var base: String = base_url.strip_edges().trim_suffix("/")
	return "%s/api/v1/sessions/%s/debug/%s" % [base, session_id.strip_edges().uri_encode(), kind]


## An http(s) origin of the Session Server, for example `http://127.0.0.1:7420`.
static func is_base_url(base_url: String) -> bool:
	var value: String = base_url.strip_edges()
	for scheme: String in ["http://", "https://"]:
		if value.begins_with(scheme) and value.length() > scheme.length():
			return true
	return false


## True if the request succeeded and the body has the shape the route answers with.
static func is_valid_answer(kind: String, result: int, status: int, body: Variant) -> bool:
	if result != HTTPRequest.RESULT_SUCCESS or status != 200 or not body is Dictionary:
		return false
	var data: Dictionary = body
	if not data.get("seed") is String:
		return false
	if kind == TRUTH:
		return data.has("truth")
	if kind == EXPORT:
		return data.get("format") == REPRO_FORMAT and data.get("snapshot") is Dictionary
	return false


## A message for the developer about a failed request. It never quotes the body or the token.
static func describe_failure(result: int, status: int) -> String:
	if result != HTTPRequest.RESULT_SUCCESS:
		return "Сервер недоступен (ошибка запроса %d)" % result
	match status:
		200:
			return "Сервер вернул ответ неожиданной формы"
		401, 403:
			return "Нет доступа (HTTP %d): нужен desktopToken этой сессии" % status
		404:
			return "Debug API недоступен (HTTP 404): сервер запущен без HS_DEBUG_TRUTH=1 или сессия не найдена"
		501:
			return "Сессию нельзя исследовать (HTTP 501)"
	return "Ошибка сервера (HTTP %d)" % status


## File name of an exported repro bundle: `repro-<sessionId>-v<stateVersion>.json`.
static func repro_file_name(session_id: String, state_version: int) -> String:
	var safe_id: String = session_id.validate_filename().replace(" ", "_")
	return "repro-%s-v%d.json" % [safe_id, maxi(state_version, 0)]
