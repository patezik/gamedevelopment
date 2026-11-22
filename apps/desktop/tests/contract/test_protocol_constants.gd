extends GutTest
## Contract: the generated ProtocolConstants agree with the JSON Schemas and fixtures of
## @hs/protocol, so a protocol change without `npm run protocol:gen` fails here.

const Support := preload("res://tests/contract/contract_support.gd")


func _messages(file_name: String) -> Array:
	var path: String = Support.fixtures_dir().path_join(file_name)
	var messages: Array = Support.read_json(path).data
	return messages


func _payload(message_value: Variant) -> Dictionary:
	var message: Dictionary = message_value
	var payload: Dictionary = message["payload"]
	return payload


func _properties(node: Dictionary) -> Dictionary:
	var properties: Dictionary = node.get("properties", {})
	return properties


## Schema of `payload.role` in the `hello` message.
func _hello_role_schema() -> Dictionary:
	var branches: Array = Support.schema("client-message.json").get("oneOf", [])
	for branch_value: Variant in branches:
		var branch: Dictionary = branch_value
		var type_schema: Dictionary = _properties(branch).get("type", {})
		if type_schema.get("const", "") == ProtocolConstants.MSG_HELLO:
			var payload: Dictionary = _properties(branch).get("payload", {})
			var role: Dictionary = _properties(payload).get("role", {})
			return role
	return {}


func test_constants_script_is_marked_generated() -> void:
	var source: String = FileAccess.get_file_as_string("res://src/net/protocol_constants.gd")
	assert_true(
		source.begins_with("# СГЕНЕРИРОВАНО — не редактировать."), "generated-file header present"
	)


func test_message_types_match_schemas() -> void:
	assert_eq(
		PackedStringArray(ProtocolConstants.CLIENT_MESSAGE_TYPES),
		Support.union_types(Support.schema("client-message.json")),
		"client message types"
	)
	assert_eq(
		PackedStringArray(ProtocolConstants.SERVER_MESSAGE_TYPES),
		Support.union_types(Support.schema("server-message.json")),
		"server message types"
	)


func test_event_types_match_schema() -> void:
	assert_eq(
		PackedStringArray(ProtocolConstants.EVENT_TYPES),
		Support.union_types(Support.schema("client-event.json"))
	)


func test_action_types_match_schema() -> void:
	assert_eq(
		PackedStringArray(ProtocolConstants.ACTION_TYPES),
		Support.union_types(Support.schema("player-action.json"))
	)


func test_error_codes_match_schema() -> void:
	var codes: Array = Support.schema("error-code.json").get("enum", [])
	assert_gt(codes.size(), 0, "error-code.json lists codes")
	assert_eq(PackedStringArray(ProtocolConstants.ERROR_CODES), PackedStringArray(codes))


func test_actions_by_role_reference_known_roles_and_actions() -> void:
	assert_eq(
		Support.sorted(ProtocolConstants.ACTIONS_BY_ROLE.keys()),
		Support.sorted(ProtocolConstants.ROLES)
	)
	var hello_role: Dictionary = _hello_role_schema()
	var hello_roles: Array = hello_role.get("enum", [])
	assert_gt(hello_roles.size(), 0, "hello payload lists roles")
	assert_eq(Support.sorted(hello_roles), Support.sorted(ProtocolConstants.ROLES))
	for role: String in ProtocolConstants.ROLES:
		var actions: Array = ProtocolConstants.ACTIONS_BY_ROLE[role]
		assert_gt(actions.size(), 0, "role %s has actions" % role)
		for action: String in actions:
			assert_has(ProtocolConstants.ACTION_TYPES, action, "%s action %s" % [role, action])


func test_message_fixtures_cover_every_message_type_once() -> void:
	var client_types: PackedStringArray = PackedStringArray()
	for message: Variant in _messages("client-messages.json"):
		client_types.append(str((message as Dictionary)["type"]))
	var server_types: PackedStringArray = PackedStringArray()
	for message: Variant in _messages("server-messages.json"):
		server_types.append(str((message as Dictionary)["type"]))
	assert_eq(client_types, PackedStringArray(ProtocolConstants.CLIENT_MESSAGE_TYPES))
	assert_eq(server_types, PackedStringArray(ProtocolConstants.SERVER_MESSAGE_TYPES))


func test_fixtures_use_protocol_version() -> void:
	var messages: Array = _messages("client-messages.json") + _messages("server-messages.json")
	for message_value: Variant in messages:
		var message: Dictionary = message_value
		var version: float = message["v"]
		assert_eq(roundi(version), ProtocolConstants.PROTOCOL_VERSION, "v of %s" % message["id"])
	var welcome: Dictionary = _payload(_messages("server-messages.json")[0])
	var welcome_version: float = welcome["protocolVersion"]
	assert_eq(roundi(welcome_version), ProtocolConstants.PROTOCOL_VERSION, "welcome version")


func test_fixture_values_are_known_constants() -> void:
	var action: Dictionary = _payload(_messages("client-messages.json")[2])["action"]
	assert_has(ProtocolConstants.DESKTOP_ACTIONS, str(action["type"]), "action.request fixture")
	for message_value: Variant in _messages("server-messages.json"):
		var payload: Dictionary = _payload(message_value)
		if payload.has("error"):
			assert_has(ProtocolConstants.ERROR_CODES, str(payload["error"]))
		if payload.has("code"):
			assert_has(ProtocolConstants.ERROR_CODES, str(payload["code"]))
		if payload.has("event"):
			var event: Dictionary = payload["event"]
			assert_has(ProtocolConstants.EVENT_TYPES, str(event["type"]))
		if payload.has("role"):
			assert_has(ProtocolConstants.ROLES, str(payload["role"]))
