extends RefCounted
## Final PlayerViews for the six endings, for the Ending preview mode and tests: the `end` fixture
## of @hs/protocol with its `ending` replaced. Titles and texts repeat the placeholders the server
## sends today (packages/core/src/game/ending.ts); `proven` is set only for an ending an accusation
## decided, as the server does. A preview aid, never used for a live session.

const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

const BASE_FIXTURE: String = "end"
const ENDINGS: Dictionary = {
	"solved": {
		"title": "Дело раскрыто",
		"text": "Виновные названы, и каждое звено обвинения подтверждено уликами.",
		"proven": {"motive": true, "means": true, "opportunity": true},
	},
	"partial": {
		"title": "За недостатком улик",
		"text": "Вы назвали верно, но доказательств не хватило: виновного отпустили.",
		"proven": {"motive": true, "means": false, "opportunity": true},
	},
	"wrong_accusation": {
		"title": "Ложное обвинение",
		"text": "Вы обвинили не того. Настоящий виновный остался на свободе.",
		"proven": {"motive": false, "means": false, "opportunity": false},
	},
	"time_up": {
		"title": "Время вышло",
		"text": "Срок расследования истёк, и обвинение так и не прозвучало.",
	},
	"death": {"title": "Гибель", "text": "Вы не пережили это расследование."},
	"madness": {"title": "Сигнал победил", "text": "Рассудок оставил вас. Сигнал победил."},
}


## The read-only final view of [param ending_id]; empty for an unknown id or a missing base
## fixture.
static func view_for(ending_id: String) -> Dictionary:
	if not ENDINGS.has(ending_id):
		return ReadOnly.empty()
	var base: Dictionary = PreviewFixtures.load_view(BASE_FIXTURE)
	if base.is_empty():
		return ReadOnly.empty()
	var view: Dictionary = base.duplicate(true)
	var source: Dictionary = ENDINGS[ending_id]
	var ending: Dictionary = (view.get("ending", {}) as Dictionary).duplicate(true)
	ending["endingId"] = ending_id
	ending["title"] = source["title"]
	ending["text"] = source["text"]
	if source.has("proven"):
		ending["proven"] = (source["proven"] as Dictionary).duplicate()
	else:
		ending.erase("proven")
	view["ending"] = ending
	if ending_id == "time_up":
		var clock: Dictionary = (view["clock"] as Dictionary).duplicate()
		clock["remainingMinutes"] = 0
		view["clock"] = clock
	elif ending_id == "death" or ending_id == "madness":
		var vitals: Dictionary = (view["vitals"] as Dictionary).duplicate()
		vitals["health" if ending_id == "death" else "sanity"] = 0
		view["vitals"] = vitals
	return ReadOnly.freeze(view)
