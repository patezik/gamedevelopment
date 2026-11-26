extends GutTest
## Contract: every JSON fixture in packages/protocol/fixtures (including fixtures/views) parses and
## has the required fields of the JSON Schema exported from @hs/protocol.

const Support := preload("res://tests/contract/contract_support.gd")

## Fixture path relative to fixtures/ -> schema file.
const SCHEMA_BY_FIXTURE: Dictionary = {
	"envelope.json": "envelope.json",
	"client-messages.json": "client-message.json",
	"server-messages.json": "server-message.json",
	"client-accusation.json": "client-message.json",
	"server-accusation.json": "server-message.json",
}
## Fixtures that are a non-empty JSON array of examples, each checked against the schema. Every
## other fixture (envelope, PlayerView, PhoneView) is a single JSON value checked as is, so an
## array in its place fails the schema's root type.
const COLLECTION_FIXTURES: Array[String] = [
	"client-messages.json",
	"server-messages.json",
	"client-accusation.json",
	"server-accusation.json",
]
## Fixture file name prefix inside fixtures/views/ -> schema file.
const SCHEMA_BY_VIEW_PREFIX: Dictionary = {
	"player-view.": "player-view.json",
	"phone-view.": "phone-view.json",
}


func _relative(path: String) -> String:
	return path.trim_prefix(Support.fixtures_dir() + "/")


func _schema_file_for(relative: String) -> String:
	if SCHEMA_BY_FIXTURE.has(relative):
		return str(SCHEMA_BY_FIXTURE[relative])
	if relative.begins_with("views/"):
		for prefix: String in SCHEMA_BY_VIEW_PREFIX:
			if relative.get_file().begins_with(prefix):
				return str(SCHEMA_BY_VIEW_PREFIX[prefix])
	return ""


## Shape problems of the parsed fixture `relative` (path inside fixtures/); empty if it fits.
func _fixture_problems(relative: String, data: Variant) -> PackedStringArray:
	var schema_file: String = _schema_file_for(relative)
	if schema_file.is_empty():
		return PackedStringArray(["%s: no schema mapped" % relative])
	var node: Dictionary = Support.schema(schema_file)
	if not (relative in COLLECTION_FIXTURES):
		return Support.shape_problems(data, node, relative)
	if typeof(data) != TYPE_ARRAY:
		return PackedStringArray(
			["%s: expected an array of examples, got %s" % [relative, type_string(typeof(data))]]
		)
	var examples: Array = data
	if examples.is_empty():
		return PackedStringArray(["%s: no examples" % relative])
	var problems: PackedStringArray = PackedStringArray()
	for index: int in examples.size():
		var item_path: String = "%s[%d]" % [relative, index]
		problems.append_array(Support.shape_problems(examples[index], node, item_path))
	return problems


func _example_count(relative: String, data: Variant) -> int:
	if relative in COLLECTION_FIXTURES and typeof(data) == TYPE_ARRAY:
		var examples: Array = data
		return examples.size()
	return 1


func _fixture(relative: String) -> Variant:
	return Support.read_json(Support.fixtures_dir().path_join(relative)).data


func test_finds_fixtures_including_views() -> void:
	var relatives: PackedStringArray = PackedStringArray()
	for path: String in Support.json_files(Support.fixtures_dir()):
		relatives.append(_relative(path))
	for file_name: String in SCHEMA_BY_FIXTURE:
		assert_has(relatives, file_name, "top-level fixture %s is present" % file_name)
	for stage: String in ["start", "mid", "end"]:
		assert_has(relatives, "views/player-view.%s.json" % stage)
		assert_has(relatives, "views/phone-view.%s.json" % stage)


func test_every_fixture_parses_as_json() -> void:
	var paths: PackedStringArray = Support.json_files(Support.fixtures_dir())
	assert_gt(paths.size(), 0, "fixtures found in %s" % Support.fixtures_dir())
	for path: String in paths:
		var file: Support.JsonFile = Support.read_json(path)
		assert_true(file.error.is_empty(), "%s parses: %s" % [_relative(path), file.error])
		assert_ne(typeof(file.data), TYPE_NIL, "%s is not null" % _relative(path))


func test_every_fixture_has_a_schema() -> void:
	for path: String in Support.json_files(Support.fixtures_dir()):
		var schema_file: String = _schema_file_for(_relative(path))
		assert_ne(schema_file, "", "%s is mapped to a schema" % _relative(path))
		assert_false(Support.schema(schema_file).is_empty(), "schema %s is readable" % schema_file)


func test_every_fixture_has_required_fields() -> void:
	var checked: int = 0
	for path: String in Support.json_files(Support.fixtures_dir()):
		var relative: String = _relative(path)
		var data: Variant = Support.read_json(path).data
		var problems: PackedStringArray = _fixture_problems(relative, data)
		assert_true(problems.is_empty(), "%s fits its schema:\n%s" % [relative, "\n".join(problems)])
		checked += _example_count(relative, data)
	# 1 envelope + 5 client + 9 server messages + 8 views at the time of PROTO-003, plus the 3
	# accusation operation messages of PROTO-005.
	assert_gte(checked, 26, "number of checked fixture examples")


func test_collection_fixtures_exist_and_are_mapped() -> void:
	for relative: String in COLLECTION_FIXTURES:
		assert_true(SCHEMA_BY_FIXTURE.has(relative), "%s is mapped to a schema" % relative)
		assert_eq(typeof(_fixture(relative)), TYPE_ARRAY, "%s is an array" % relative)


func test_single_view_wrapped_in_array_is_rejected() -> void:
	for relative: String in ["views/player-view.start.json", "views/phone-view.start.json"]:
		var view: Variant = _fixture(relative)
		assert_eq(_fixture_problems(relative, view), PackedStringArray(), "%s as is" % relative)
		var problems: PackedStringArray = _fixture_problems(relative, [view])
		assert_false(problems.is_empty(), "%s wrapped in an array is rejected" % relative)
		assert_string_contains("\n".join(problems), "expected object, got Array")


func test_envelope_wrapped_in_array_is_rejected() -> void:
	var envelope: Variant = _fixture("envelope.json")
	assert_false(_fixture_problems("envelope.json", [envelope]).is_empty())


func test_collection_fixture_must_be_a_non_empty_array() -> void:
	var messages: Array = _fixture("client-messages.json")
	var single: Variant = messages[0]
	var not_array: PackedStringArray = _fixture_problems("client-messages.json", single)
	assert_string_contains("\n".join(not_array), "expected an array of examples")
	var empty: PackedStringArray = _fixture_problems("client-messages.json", [])
	assert_string_contains("\n".join(empty), "no examples")


func test_shape_check_reports_missing_required_field() -> void:
	var view: Dictionary = _fixture("views/player-view.start.json")
	var broken: Dictionary = view.duplicate(true)
	broken.erase("clock")
	var problems: PackedStringArray = Support.shape_problems(
		broken, Support.schema("player-view.json"), "$"
	)
	assert_has(problems, "$: missing required field \"clock\"")


func test_shape_check_reports_missing_payload_field() -> void:
	var messages: Array = _fixture("client-messages.json")
	var hello: Dictionary = (messages[0] as Dictionary).duplicate(true)
	var payload: Dictionary = hello["payload"]
	payload.erase("token")
	var problems: PackedStringArray = Support.shape_problems(
		hello, Support.schema("client-message.json"), "$"
	)
	assert_false(problems.is_empty(), "hello without payload.token is rejected")
	assert_string_contains("\n".join(problems), "missing required field \"token\"")


func test_shape_check_reports_unknown_type_and_wrong_types() -> void:
	var node: Dictionary = Support.schema("server-message.json")
	var unknown: Dictionary = {"v": 1, "type": "nope", "id": "s-0", "payload": {}}
	assert_false(Support.shape_problems(unknown, node, "$").is_empty(), "unknown type rejected")
	var wrong_version: Dictionary = {"v": "1", "type": "pong", "id": "s-0", "payload": {}}
	assert_false(Support.shape_problems(wrong_version, node, "$").is_empty(), "string v rejected")
	var pong: Dictionary = {"v": 1.0, "type": "pong", "id": "s-0", "payload": {}}
	assert_eq(Support.shape_problems(pong, node, "$"), PackedStringArray(), "pong accepted")
