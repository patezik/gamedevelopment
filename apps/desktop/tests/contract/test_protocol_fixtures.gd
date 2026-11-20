extends GutTest
## Contract: every JSON fixture in packages/protocol/fixtures (including fixtures/views) parses and
## has the required fields of the JSON Schema exported from @hs/protocol.

const Support := preload("res://tests/contract/contract_support.gd")

## Fixture path relative to fixtures/ -> schema file. A fixture holding a JSON array is a list of
## examples, each checked against the schema.
const SCHEMA_BY_FIXTURE: Dictionary = {
	"envelope.json": "envelope.json",
	"client-messages.json": "client-message.json",
	"server-messages.json": "server-message.json",
}
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


func _examples(data: Variant) -> Array:
	if typeof(data) == TYPE_ARRAY:
		var list: Array = data
		return list
	return [data]


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
		var schema_file: String = _schema_file_for(relative)
		if schema_file.is_empty():
			continue
		var node: Dictionary = Support.schema(schema_file)
		var examples: Array = _examples(Support.read_json(path).data)
		assert_gt(examples.size(), 0, "%s has examples" % relative)
		for index: int in examples.size():
			var problems: PackedStringArray = Support.shape_problems(examples[index], node, "$")
			assert_true(
				problems.is_empty(),
				"%s[%d] fits %s:\n%s" % [relative, index, schema_file, "\n".join(problems)]
			)
			checked += 1
	# 1 envelope + 5 client + 9 server messages + 8 views at the time of PROTO-003.
	assert_gte(checked, 23, "number of checked fixture examples")


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
