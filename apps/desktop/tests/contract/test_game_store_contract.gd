extends GutTest
## Contract: the GameStore guard against server truth matches FORBIDDEN_VIEW_KEYS of @hs/protocol,
## and every PlayerView fixture passes it.

const Support := preload("res://tests/contract/contract_support.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")


func test_forbidden_view_keys_match_protocol() -> void:
	var path: String = Support.protocol_dir().path_join("src/views/common.ts")
	var source: String = FileAccess.get_file_as_string(path)
	var list: RegExMatch = RegEx.create_from_string(
		r"FORBIDDEN_VIEW_KEYS\s*=\s*\[([^\]]*)\]"
	).search(source)
	assert_not_null(list, "FORBIDDEN_VIEW_KEYS is declared in %s" % path)
	if list == null:
		return
	var protocol_keys: PackedStringArray = PackedStringArray()
	for item: RegExMatch in RegEx.create_from_string("'([^']+)'").search_all(list.get_string(1)):
		protocol_keys.append(item.get_string(1))
	protocol_keys.sort()
	var store_keys: PackedStringArray = PackedStringArray(GameStoreScript.FORBIDDEN_VIEW_KEYS)
	store_keys.sort()

	assert_gt(protocol_keys.size(), 0)
	assert_eq(store_keys, protocol_keys)


func test_every_player_view_fixture_is_accepted() -> void:
	var checked: int = 0
	for path: String in Support.json_files(Support.fixtures_dir().path_join("views")):
		if not path.get_file().begins_with("player-view"):
			continue
		var file: Support.JsonFile = Support.read_json(path)
		assert_eq(file.error, "", path)
		var store: GameStoreScript = autofree(GameStoreScript.new())
		var view: Dictionary = file.data
		assert_true(store.set_view(view, 1), path)
		checked += 1
	assert_gt(checked, 0, "PlayerView fixtures were found")
