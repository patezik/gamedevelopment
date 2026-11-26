extends RefCounted
## Pure helpers of the Accusation screen: who the view lets the player name, and the `accuse`
## action of protocol.md §4 built from the player's choice.
##
## Nothing here judges a case (ADR 0002): which claims are proven and which ending follows is
## decided by the server (`evaluateAccusation`, ENG-006). A claim is written the way the
## Investigation Engine names an established claim (`ClaimRef`, investigation-model.md §6):
## `motive(<subject>,<target>)`, `means(<subject>)`, `opportunity(<subject>)`.

const ReadOnly = preload("res://src/util/read_only.gd")

## Parts of a case file the player may claim, in screen order.
const PARTS: Array[String] = ["motive", "means", "opportunity"]
const PART_TEXT: Dictionary = {
	"motive": "мотив",
	"means": "средство",
	"opportunity": "возможность",
}
const UNKNOWN_CHARACTER_TEXT: String = "Неизвестный персонаж"


## Characters the view names, in its order: persons of interest, motive targets, marked
## characters, statement speakers, characters present, the conversation partner. Each entry is `{"id", "name"}`.
## The same sources the case board uses for its filter; the view has no full list of characters.
static func known_characters(view: Dictionary) -> Array[Dictionary]:
	var names: Dictionary = {}
	var order: Array[String] = []
	var board: Dictionary = _dict(view.get("caseBoard"))
	for person: Dictionary in _dicts(board.get("personsOfInterest")):
		_learn(names, order, _text(person.get("characterId")), _text(person.get("name")))
	for target: Dictionary in _dicts(board.get("motiveTargets")):
		_learn(names, order, _text(target.get("characterId")), _text(target.get("name")))
	for suspicion: Dictionary in _dicts(board.get("suspicions")):
		_learn(names, order, _text(suspicion.get("characterId")), "")
	for statement: Dictionary in _dicts(board.get("statements")):
		_learn(names, order, _text(statement.get("characterId")), "")
	for character: Dictionary in _dicts(view.get("presentCharacters")):
		_learn(names, order, _text(character.get("id")), _text(character.get("name")))
	var interaction: Dictionary = _dict(view.get("interaction"))
	_learn(names, order, _text(interaction.get("characterId")), _text(interaction.get("characterName")))
	var result: Array[Dictionary] = []
	for character_id: String in order:
		var name: String = str(names.get(character_id, ""))
		result.append({"id": character_id, "name": name if not name.is_empty() else UNKNOWN_CHARACTER_TEXT})
	return result


## Clues the player holds (`caseBoard.clues`), in the order of the view.
static func clues(view: Dictionary) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for clue: Dictionary in _dicts(_dict(view.get("caseBoard")).get("clues")):
		if not _text(clue.get("id")).is_empty():
			result.append(clue)
	return result


## The ClaimRef of [param part] about [param subject]; [param target] is whom the motive is
## against (ignored for means and opportunity). Empty when the claim is incomplete.
static func claim_ref(part: String, subject: String, target: String = "") -> String:
	if subject.is_empty() or not PARTS.has(part):
		return ""
	if part == "motive":
		return "" if target.is_empty() else "motive(%s,%s)" % [subject, target]
	return "%s(%s)" % [part, subject]


## The `caseFile` of the `accuse` action. [param claims] maps a part to its ClaimRef; empty refs
## are left out (the parts are optional in the contract). Evidence keeps the given order without
## repeats.
static func case_file(accused_ids: Array[String], claims: Dictionary, evidence: Array[String]) -> Dictionary:
	# Plain (untyped) arrays: the case file is wire data.
	var accused: Array = []
	for character_id: String in accused_ids:
		if not character_id.is_empty() and not accused.has(character_id):
			accused.append(character_id)
	var attached: Array = []
	for clue_id: String in evidence:
		if not clue_id.is_empty() and not attached.has(clue_id):
			attached.append(clue_id)
	var file: Dictionary = {"accusedIds": accused, "evidence": attached}
	for part: String in PARTS:
		var ref: String = str(claims.get(part, ""))
		if not ref.is_empty():
			file[part] = ref
	return file


## The `accuse` PlayerAction; [param confirm] false only asks the server to confirm. A confirmed
## accusation carries [param operation_id], which stays the same on every retry (ADR 0022).
static func accuse_action(file: Dictionary, confirm: bool, operation_id: String = "") -> Dictionary:
	var action: Dictionary = {
		"type": ProtocolConstants.ACTION_ACCUSE, "caseFile": file.duplicate(true), "confirm": confirm
	}
	if confirm and not operation_id.is_empty():
		action["operationId"] = operation_id
	return action


## A new random ID for one irreversible accusation.
static func new_operation_id() -> String:
	return "op-" + Crypto.new().generate_random_bytes(12).hex_encode()


## Parts of [param file] the player left out, as screen words ("мотив", ...), plus "улики" when
## no clue is attached. A hint for the confirmation, not a judgement.
static func missing_parts(file: Dictionary) -> Array[String]:
	var missing: Array[String] = []
	for part: String in PARTS:
		if _text(file.get(part)).is_empty():
			missing.append(str(PART_TEXT[part]))
	var evidence: Variant = file.get("evidence")
	if not evidence is Array or (evidence as Array).is_empty():
		missing.append("улики")
	return missing


static func _learn(names: Dictionary, order: Array[String], character_id: String, name: String) -> void:
	if character_id.is_empty():
		return
	if not order.has(character_id):
		order.append(character_id)
	if not name.is_empty() and not names.has(character_id):
		names[character_id] = name


static func _dict(value: Variant) -> Dictionary:
	if value is Dictionary:
		var result: Dictionary = value
		return result
	return ReadOnly.empty()


static func _dicts(value: Variant) -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if value is Array:
		var items: Array = value
		for item: Variant in items:
			if item is Dictionary:
				result.append(item as Dictionary)
	return result


static func _text(value: Variant) -> String:
	if value is String:
		var text: String = value
		return text
	return ""
