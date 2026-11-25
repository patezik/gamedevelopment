extends GutTest
## The large case board fixture is a valid PlayerView: it has the shape of
## packages/protocol/schemas/player-view.json and no server-only field.

const Support = preload("res://tests/contract/contract_support.gd")
const CaseBoardFixtures = preload("res://src/scenes/case_board/case_board_fixtures.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")


func test_large_fixture_matches_the_player_view_schema() -> void:
	for clue_count: int in [0, 24, 100]:
		# Through JSON, as a view arrives from the server.
		var view: Variant = JSON.parse_string(JSON.stringify(CaseBoardFixtures.large_view(clue_count)))
		var problems: PackedStringArray = Support.shape_problems(
			view, Support.schema("player-view.json"), "$"
		)
		assert_eq(problems, PackedStringArray(), "large_view(%d) is a PlayerView" % clue_count)
		assert_eq(GameStoreScript.find_forbidden_key(view), "", "no server-only field")


func test_large_fixture_has_more_than_twenty_clues() -> void:
	var view: Dictionary = CaseBoardFixtures.large_view()
	var clues: Array = (view["caseBoard"] as Dictionary)["clues"]
	assert_gt(clues.size(), 20)
