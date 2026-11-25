extends GutTest

const KnownMap = preload("res://src/ui/known_map.gd")
const LocationMap = preload("res://src/ui/location_map.gd")

var _map: KnownMap


func before_each() -> void:
	_map = KnownMap.new()


func _view(location_id: String, location_name: String, exits: Array) -> Dictionary:
	var exit_views: Array = []
	for exit: Variant in exits:
		var pair: Array = exit
		exit_views.append({"locationId": pair[0], "name": pair[1], "minutes": 3})
	return {"location": {"id": location_id, "name": location_name, "exits": exit_views}}


func test_observing_a_view_adds_the_location_and_its_exits() -> void:
	_map.observe(_view("loc_lobby", "Холл", [["loc_corridor", "Коридор"], ["loc_garden", "Сад"]]))

	assert_eq(_map.location_ids(), ["loc_lobby", "loc_corridor", "loc_garden"] as Array[String])
	assert_eq(_map.current(), "loc_lobby")
	assert_true(_map.is_visited("loc_lobby"))
	assert_false(_map.is_visited("loc_corridor"), "an exit is seen, not visited")
	assert_eq(_map.location_name("loc_garden"), "Сад")
	assert_true(_map.has_link("loc_corridor", "loc_lobby"), "links are undirected")
	assert_false(_map.has_link("loc_corridor", "loc_garden"), "no link the views did not show")


func test_views_accumulate_and_move_the_current_location() -> void:
	_map.observe(_view("loc_lobby", "Холл", [["loc_corridor", "Коридор"]]))
	_map.observe(_view("loc_corridor", "Главный коридор", [["loc_lobby", "Холл"], ["loc_ward", "Палата"]]))

	assert_eq(_map.current(), "loc_corridor")
	assert_true(_map.is_visited("loc_lobby"))
	assert_true(_map.is_visited("loc_corridor"))
	assert_eq(_map.location_name("loc_corridor"), "Главный коридор", "the latest name wins")
	assert_eq(_map.links().size(), 2)


func test_layout_columns_are_link_distance_from_the_current_location() -> void:
	_map.observe(_view("loc_lobby", "Холл", [["loc_corridor", "Коридор"]]))
	_map.observe(_view("loc_corridor", "Коридор", [["loc_lobby", "Холл"], ["loc_ward", "Палата"]]))
	_map.observe(_view("loc_ward", "Палата", [["loc_corridor", "Коридор"]]))

	var cells: Dictionary = _map.layout()
	var ward: Vector2i = cells["loc_ward"]
	var corridor: Vector2i = cells["loc_corridor"]
	var lobby: Vector2i = cells["loc_lobby"]
	assert_eq(ward, Vector2i(0, 0))
	assert_eq(corridor, Vector2i(1, 0))
	assert_eq(lobby, Vector2i(2, 0))


func test_unlinked_locations_get_their_own_column() -> void:
	_map.observe(_view("loc_lobby", "Холл", [["loc_corridor", "Коридор"]]))
	_map.observe(_view("loc_attic", "Чердак", []))

	var cells: Dictionary = _map.layout()
	var attic: Vector2i = cells["loc_attic"]
	var lobby: Vector2i = cells["loc_lobby"]
	var corridor: Vector2i = cells["loc_corridor"]
	assert_eq(attic, Vector2i(0, 0))
	assert_eq(lobby, Vector2i(1, 0))
	assert_eq(corridor, Vector2i(1, 1))


func test_incomplete_views_change_nothing() -> void:
	_map.observe({})
	_map.observe({"location": "loc_lobby"})
	_map.observe({"location": {"name": "Без id"}})
	assert_true(_map.is_empty())

	_map.observe({"location": {"id": "loc_lobby", "exits": ["bad", {"name": "без id"}, {"locationId": "loc_lobby"}]}})
	assert_eq(_map.location_ids(), ["loc_lobby"] as Array[String])
	assert_eq(_map.links().size(), 0, "no self links, no exits without an id")


func test_clear_forgets_everything() -> void:
	_map.observe(_view("loc_lobby", "Холл", [["loc_corridor", "Коридор"]]))
	_map.clear()
	assert_true(_map.is_empty())
	assert_eq(_map.current(), "")
	assert_eq(_map.links().size(), 0)


func test_location_map_draws_one_box_per_known_location() -> void:
	_map.observe(_view("loc_lobby", "Холл", [["loc_corridor", "Коридор"]]))
	var widget: LocationMap = LocationMap.new()
	add_child_autofree(widget)

	widget.show_map(_map)

	var boxes: Array[Label] = widget.location_boxes()
	assert_eq(boxes.size(), 2)
	assert_eq(boxes[0].text, "Холл")
	var first_current: bool = boxes[0].get_meta(LocationMap.META_CURRENT)
	var second_visited: bool = boxes[1].get_meta(LocationMap.META_VISITED)
	assert_true(first_current)
	assert_false(second_visited)
	assert_gt(widget.custom_minimum_size.x, 0.0)

	_map.clear()
	widget.show_map(_map)
	assert_eq(widget.location_boxes().size(), 0)


func test_known_map_field_restores_history_the_client_did_not_observe() -> void:
	var view: Dictionary = _view("loc_corridor", "Коридор", [["loc_lobby", "Холл"]])
	view["knownMap"] = {
		"locations": [
			{"id": "loc_corridor", "name": "Коридор", "visited": true},
			{"id": "loc_lobby", "name": "Холл", "visited": true},
			{"id": "loc_cellar", "name": "Подвал", "visited": false},
		],
		"links": [{"from": "loc_lobby", "to": "loc_cellar"}, {"from": "loc_corridor", "to": "loc_lobby"}],
	}
	_map.observe(view)

	assert_true(_map.is_visited("loc_lobby"))
	assert_false(_map.is_visited("loc_cellar"))
	assert_true(_map.has_link("loc_cellar", "loc_lobby"))
	assert_true(_map.has_link("loc_corridor", "loc_lobby"))
	assert_eq(_map.current(), "loc_corridor")
