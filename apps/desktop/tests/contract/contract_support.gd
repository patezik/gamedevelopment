extends RefCounted
## Helpers for the protocol contract tests: locate @hs/protocol in the monorepo, read its JSON files
## and check a value against the shape of a generated JSON Schema.
##
## The shape check covers required fields, unknown fields, JSON types, `const`, `enum`, arrays and
## `oneOf`/`anyOf` unions. Numeric ranges, string lengths and patterns are deliberately ignored:
## full validation is the server's job (ADR 0009).

## packages/protocol relative to the Godot project directory (apps/desktop).
const PROTOCOL_PACKAGE: String = "../../packages/protocol"


## Result of reading a JSON file: `error` is empty when `data` holds the parsed value.
class JsonFile:
	var data: Variant = null
	var error: String = ""


static func protocol_dir() -> String:
	var project_dir: String = ProjectSettings.globalize_path("res://")
	return project_dir.path_join(PROTOCOL_PACKAGE).simplify_path()


static func fixtures_dir() -> String:
	return protocol_dir().path_join("fixtures")


static func schemas_dir() -> String:
	return protocol_dir().path_join("schemas")


## Every `*.json` file under `directory`, including subdirectories, as sorted absolute paths.
static func json_files(directory: String) -> PackedStringArray:
	var found: PackedStringArray = PackedStringArray()
	var dir: DirAccess = DirAccess.open(directory)
	if dir == null:
		return found
	for file_name: String in dir.get_files():
		if file_name.get_extension() == "json":
			found.append(directory.path_join(file_name))
	for child: String in dir.get_directories():
		found.append_array(json_files(directory.path_join(child)))
	found.sort()
	return found


static func read_json(path: String) -> JsonFile:
	var result: JsonFile = JsonFile.new()
	if not FileAccess.file_exists(path):
		result.error = "%s: file not found" % path
		return result
	var json: JSON = JSON.new()
	var status: Error = json.parse(FileAccess.get_file_as_string(path))
	if status != OK:
		result.error = (
			"%s:%d: %s" % [path, json.get_error_line(), json.get_error_message()]
		)
		return result
	result.data = json.data
	return result


## The parsed JSON Schema `schemas/<file_name>`; an empty dictionary if it cannot be read.
static func schema(file_name: String) -> Dictionary:
	var file: JsonFile = read_json(schemas_dir().path_join(file_name))
	if not file.error.is_empty() or typeof(file.data) != TYPE_DICTIONARY:
		return {}
	var parsed: Dictionary = file.data
	return parsed


## `const` values of the `type` property of each `oneOf` branch, in schema order.
static func union_types(union_schema: Dictionary) -> PackedStringArray:
	var types: PackedStringArray = PackedStringArray()
	var branches: Array = union_schema.get("oneOf", [])
	for branch_value: Variant in branches:
		var branch: Dictionary = branch_value
		var properties: Dictionary = branch.get("properties", {})
		var type_schema: Dictionary = properties.get("type", {})
		types.append(str(type_schema.get("const", "")))
	return types


static func sorted(values: Array) -> PackedStringArray:
	var copy: PackedStringArray = PackedStringArray(values)
	copy.sort()
	return copy


## Shape problems of `value` against `node`, each prefixed with the JSON path; empty if it fits.
static func shape_problems(value: Variant, node: Dictionary, path: String) -> PackedStringArray:
	if node.has("oneOf"):
		var one_of: Array = node["oneOf"]
		return _union_problems(value, one_of, true, path)
	if node.has("anyOf"):
		var any_of: Array = node["anyOf"]
		return _union_problems(value, any_of, false, path)

	var problems: PackedStringArray = PackedStringArray()
	var expected_type: String = str(node.get("type", ""))
	if not expected_type.is_empty() and not _has_json_type(value, expected_type):
		problems.append(
			"%s: expected %s, got %s" % [path, expected_type, type_string(typeof(value))]
		)
		return problems
	if node.has("const") and not _json_equal(value, node["const"]):
		problems.append(
			"%s: expected %s, got %s" % [path, JSON.stringify(node["const"]), JSON.stringify(value)]
		)
	if node.has("enum"):
		var options: Array = node["enum"]
		var listed: bool = false
		for option: Variant in options:
			listed = listed or _json_equal(value, option)
		if not listed:
			problems.append(
				"%s: %s is not one of %s" % [path, JSON.stringify(value), JSON.stringify(options)]
			)

	if expected_type == "object":
		var object: Dictionary = value
		problems.append_array(_object_problems(object, node, path))
	elif expected_type == "array" and node.has("items"):
		var items: Array = value
		var item_schema: Dictionary = node["items"]
		for index: int in items.size():
			var item_path: String = "%s[%d]" % [path, index]
			problems.append_array(shape_problems(items[index], item_schema, item_path))
	return problems


static func _object_problems(
	object: Dictionary, node: Dictionary, path: String
) -> PackedStringArray:
	var problems: PackedStringArray = PackedStringArray()
	var properties: Dictionary = node.get("properties", {})
	var required: Array = node.get("required", [])
	for key: Variant in required:
		if not object.has(key):
			problems.append("%s: missing required field \"%s\"" % [path, key])
	var additional: Variant = node.get("additionalProperties", true)
	for key: Variant in object:
		var child_path: String = "%s.%s" % [path, key]
		if properties.has(key):
			var child: Dictionary = properties[key]
			problems.append_array(shape_problems(object[key], child, child_path))
		elif typeof(additional) == TYPE_DICTIONARY:
			var additional_schema: Dictionary = additional
			problems.append_array(shape_problems(object[key], additional_schema, child_path))
		elif typeof(additional) == TYPE_BOOL:
			var allowed: bool = additional
			if not allowed:
				problems.append("%s: unknown field" % child_path)
	return problems


static func _union_problems(
	value: Variant, branches: Array, exactly_one: bool, path: String
) -> PackedStringArray:
	var matches: int = 0
	var closest: PackedStringArray = PackedStringArray()
	for branch_value: Variant in branches:
		var branch: Dictionary = branch_value
		var problems: PackedStringArray = shape_problems(value, branch, path)
		if problems.is_empty():
			matches += 1
		elif closest.is_empty() or problems.size() < closest.size():
			closest = problems
	if matches == 0:
		var result: PackedStringArray = PackedStringArray(
			["%s: matches no variant; closest:" % path]
		)
		result.append_array(closest)
		return result
	if exactly_one and matches > 1:
		return PackedStringArray(["%s: matches %d variants of oneOf" % [path, matches]])
	return PackedStringArray()


static func _has_json_type(value: Variant, json_type: String) -> bool:
	match json_type:
		"object":
			return typeof(value) == TYPE_DICTIONARY
		"array":
			return typeof(value) == TYPE_ARRAY
		"string":
			return typeof(value) == TYPE_STRING
		"boolean":
			return typeof(value) == TYPE_BOOL
		"null":
			return typeof(value) == TYPE_NIL
		"number":
			return typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT
		"integer":
			if typeof(value) == TYPE_INT:
				return true
			if typeof(value) != TYPE_FLOAT:
				return false
			var number: float = value
			return is_finite(number) and number == floorf(number)
	return false


## JSON values compare by type and value; Godot parses every JSON number as float.
static func _json_equal(left: Variant, right: Variant) -> bool:
	var numeric: Array[int] = [TYPE_INT, TYPE_FLOAT]
	if typeof(left) in numeric and typeof(right) in numeric:
		var left_number: float = left
		var right_number: float = right
		return left_number == right_number
	return typeof(left) == typeof(right) and left == right
