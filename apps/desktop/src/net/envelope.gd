extends RefCounted

const MAX_BYTES: int = 256 * 1024
const MAX_SAFE_INTEGER: int = 9007199254740991
const SERVER_FIELDS: Array[String] = ["v", "type", "id", "seq", "payload"]


static func counter(value: Variant) -> int:
	if value is int:
		return value if value >= 0 and value <= MAX_SAFE_INTEGER else -1
	if not value is float:
		return -1
	var number: float = value as float
	if not is_finite(number) or number < 0.0 or number > float(MAX_SAFE_INTEGER) or floor(number) != number:
		return -1
	return int(number)


static func parse_server(packet: PackedByteArray) -> Dictionary:
	if packet.size() > MAX_BYTES:
		return {}
	var json: JSON = JSON.new()
	if json.parse(packet.get_string_from_utf8()) != OK or not json.data is Dictionary:
		return {}
	var message: Dictionary = json.data as Dictionary
	for field: Variant in message:
		if not field is String or not SERVER_FIELDS.has(str(field)):
			return {}
	var kind: Variant = message.get("type")
	var request_id: Variant = message.get("id")
	if counter(message.get("v")) != ProtocolConstants.PROTOCOL_VERSION:
		return {}
	if not kind is String or not ProtocolConstants.SERVER_MESSAGE_TYPES.has(str(kind)):
		return {}
	if not request_id is String or str(request_id).is_empty() or not message.get("payload") is Dictionary:
		return {}
	if message.has("seq") and counter(message.get("seq")) < 0:
		return {}
	return message
