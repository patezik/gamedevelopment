extends RefCounted
## A large PlayerView for the case board: [param clue_count] clues and the statements,
## contradictions, persons of interest, suspicion marks and timeline that go with them.
##
## Built in code, deterministically (no randomness, no files), so it works in an exported build too.
## The board opens it with the route param `{"preview": "large"}`; the GUT tests and the manual FPS
## check (apps/desktop/tests/perf) use it as the 20+ clue fixture. It holds only what a PlayerView
## may hold: no server-only field, and the contract test checks it against the PlayerView schema.

const ReadOnly = preload("res://src/util/read_only.gd")

const DEFAULT_CLUE_COUNT: int = 24
const KINDS: Array[String] = ["physical", "document", "digital", "testimonial"]
const CHARACTERS: Array[Array] = [
	["ch_doctor", "Доктор Левин"],
	["ch_nurse", "Медсестра Орлова"],
	["ch_porter", "Швейцар Гусев"],
	["ch_cook", "Повар Мамедов"],
	["ch_guest", "Гостья Ветрова"],
	["ch_chief", "Главврач Стрельцов"],
	["ch_janitor", "Дворник Кузьмич"],
	["ch_widow", "Вдова Ланская"],
]
const LOCATIONS: Array[Array] = [
	["loc_lobby", "Вестибюль"],
	["loc_corridor", "Коридор второго этажа"],
	["loc_infirmary", "Процедурная"],
	["loc_garden", "Зимний сад"],
]
## The board shows the view at day 2, 08:20 (minute 1460 from day 1, 08:00).
const NOW: int = 1460
const DAY_START: int = 480


static func large_view(clue_count: int = DEFAULT_CLUE_COUNT) -> Dictionary:
	var clues: Array = []
	for index: int in clue_count:
		var location: Array = LOCATIONS[index % LOCATIONS.size()]
		clues.append({
			"id": "clue_%02d" % index,
			"title": "Улика %d" % (index + 1),
			"description": "Описание улики %d: что игрок увидел и где." % (index + 1),
			"kind": KINDS[index % KINDS.size()],
			"discoveredAt": 30 + index * 55,
			"locationId": location[0],
			"captured": index % 3 != 0,
		})
	var statements: Array = []
	for index: int in CHARACTERS.size() * 2:
		statements.append({
			"id": "st_%02d" % index,
			"characterId": CHARACTERS[index % CHARACTERS.size()][0],
			"topicId": "topic_%d" % (index % 3),
			"text": "Показание %d: где был и что видел." % (index + 1),
			"heardAt": 60 + index * 80,
		})
	var contradictions: Array = []
	for index: int in 6:
		contradictions.append({
			"id": "con_%02d" % index,
			"statementId": "st_%02d" % index,
			"againstId": "clue_%02d" % ((index * 3) % maxi(clue_count, 1)),
			"summary": "Противоречие %d: показание расходится с уликой." % (index + 1),
		})
	var persons: Array = []
	for index: int in 6:
		var linked: Array = []
		for offset: int in 4:
			var clue_index: int = (index * 4 + offset) % maxi(clue_count, 1)
			if clue_count > 0:
				linked.append("clue_%02d" % clue_index)
		persons.append({
			"characterId": CHARACTERS[index][0],
			"name": CHARACTERS[index][1],
			"linkedClueIds": linked,
		})
	var timeline: Array = []
	for index: int in 12:
		var entry: Dictionary = {
			"id": "tl_%02d" % index,
			"from": -120 + index * 130,
			"text": "Событие %d хронологии" % (index + 1),
			"sourceIds": ["st_%02d" % index, "clue_%02d" % (index % maxi(clue_count, 1))],
		}
		if index % 2 == 0:
			entry["to"] = -120 + index * 130 + 45
		timeline.append(entry)
	var view: Dictionary = {
		"clock": {
			"t": NOW,
			"day": 2,
			"time": "08:20",
			"period": "morning",
			"remainingMinutes": 2860,
		},
		"location": {
			"id": LOCATIONS[0][0],
			"name": LOCATIONS[0][1],
			"description": "Холодный вестибюль санатория.",
			"lighting": "dim",
			"hotspots": [],
			"exits": [
				{"locationId": LOCATIONS[1][0], "name": LOCATIONS[1][1], "minutes": 5},
				{"locationId": LOCATIONS[3][0], "name": LOCATIONS[3][1], "minutes": 10},
			],
		},
		"presentCharacters": [
			{
				"id": CHARACTERS[6][0],
				"name": CHARACTERS[6][1],
				"portraitRef": "portrait_janitor_01",
				"demeanor": "хмурый",
			},
		],
		"availableActions": [],
		"vitals": {"health": 8, "sanity": 6, "fatigue": 40},
		"static": 30,
		"inventory": [],
		"caseBoard": {
			"clues": clues,
			"statements": statements,
			"contradictions": contradictions,
			"personsOfInterest": persons,
			"motiveTargets": [],
			"suspicions": [
				{"characterId": CHARACTERS[0][0], "level": "prime", "note": "Ключ от процедурной"},
				{"characterId": CHARACTERS[2][0], "level": "possible"},
				{"characterId": CHARACTERS[7][0], "level": "possible", "note": "Не видна ни в одной улике"},
			],
			"timeline": timeline,
		},
		"phone": {"paired": true, "online": true, "battery": 71},
	}
	return ReadOnly.freeze(view)
