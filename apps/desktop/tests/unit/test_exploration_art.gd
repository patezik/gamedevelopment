extends GutTest
## Exploration art (GDT-012): the plate of `location.id`/`location.lighting` at ×3 with nearest
## filtering, the dip to black on a change of lighting, framed portraits from `portraitRef` and
## placeholders when art is missing. Everything is driven by PlayerView fields only.

const ExplorationScene = preload("res://src/scenes/exploration/exploration.tscn")
const Exploration = preload("res://src/scenes/exploration/exploration.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const ArtLibrary = preload("res://src/ui/art_library.gd")
const PortraitFrame = preload("res://src/ui/portrait_frame.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")

const HALL_DIM: String = "res://assets/art/scenarios/sanatorium_winter/locations/loc_hall.dim.png"
const HALL_BRIGHT: String = "res://assets/art/scenarios/sanatorium_winter/locations/loc_hall.bright.png"
const DOCTOR: String = "res://assets/art/scenarios/sanatorium_winter/portraits/head_doctor.m1.png"

var _backend: FakeBackend
var _store: GameStoreScript
var _version: int = 0


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	_version = 0


func _screen(params: Dictionary = {}) -> Exploration:
	var screen: Exploration = ExplorationScene.instantiate() as Exploration
	screen.set_params(params)
	screen.bind_store(_store)
	add_child_autofree(screen)
	return screen


## The `start` fixture moved to [param location_id] in [param lighting], with the present
## characters' portraitRef replaced by [param portraits] in order.
func _view(location_id: String, lighting: String, portraits: Array[String] = []) -> Dictionary:
	var view: Dictionary = PreviewFixtures.load_view("start").duplicate(true)
	var location: Dictionary = view["location"]
	location["id"] = location_id
	location["lighting"] = lighting
	var characters: Array = view["presentCharacters"]
	for index: int in mini(characters.size(), portraits.size()):
		(characters[index] as Dictionary)["portraitRef"] = portraits[index]
	return view


func _publish(view: Dictionary) -> void:
	_version += 1
	assert_true(_store.set_view(view, _version), "view %d accepted" % _version)


func _part(screen: Exploration, unique_name: String) -> Node:
	return screen.get_node(NodePath("%" + unique_name))


func _image(screen: Exploration) -> TextureRect:
	return _part(screen, "PlateImage") as TextureRect


func _frames(node: Node) -> Array[PortraitFrame]:
	var found: Array[PortraitFrame] = []
	if node is PortraitFrame:
		found.append(node as PortraitFrame)
	for child: Node in node.get_children():
		found.append_array(_frames(child))
	return found


func _plate_shown(screen: Exploration, path: String) -> bool:
	var image: TextureRect = _image(screen)
	return image.visible and image.texture != null and image.texture.resource_path == path


func test_plate_node_draws_at_integer_scale_with_nearest_filtering() -> void:
	var screen: Exploration = _screen()
	var plate: Control = _part(screen, "Plate") as Control
	var image: TextureRect = _image(screen)

	assert_eq(image.scale, Vector2(ArtLibrary.PLATE_SCALE, ArtLibrary.PLATE_SCALE))
	assert_eq(image.scale, image.scale.floor(), "integer scale")
	assert_eq(image.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_eq(plate.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_eq(image.size, Vector2(ArtLibrary.PLATE_SIZE))
	assert_eq(image.stretch_mode, TextureRect.STRETCH_KEEP)
	assert_eq(plate.custom_minimum_size, Vector2(ArtLibrary.PLATE_SIZE * ArtLibrary.PLATE_SCALE))


func test_location_with_art_shows_the_plate_of_its_lighting() -> void:
	_publish(_view("loc_hall", "dim"))
	var screen: Exploration = _screen()

	assert_eq(screen.get_plate_path(), HALL_DIM)
	await wait_until(func() -> bool: return _plate_shown(screen, HALL_DIM), 5.0)
	assert_true(_plate_shown(screen, HALL_DIM), "loc_hall.dim.png on screen")
	assert_eq(Vector2i(_image(screen).texture.get_size()), ArtLibrary.PLATE_SIZE)


func test_location_without_art_keeps_the_placeholder_without_errors() -> void:
	_publish(PreviewFixtures.load_view("start"))
	var screen: Exploration = _screen()
	await wait_process_frames(2)

	assert_false(_image(screen).visible)
	assert_null(_image(screen).texture)
	assert_eq(
		(_part(screen, "PlatePlaceholder") as ColorRect).color,
		Exploration._placeholder_color("loc_lobby", "bright")
	)
	assert_true(screen.get_art_library().is_missing(screen.get_plate_path()))


func test_lighting_level_without_a_plate_falls_back_to_the_placeholder() -> void:
	_publish(_view("loc_hall", "dark"))
	var screen: Exploration = _screen()
	await wait_process_frames(2)

	assert_false(_image(screen).visible, "loc_hall has no dark plate")


func test_change_of_lighting_dips_to_black_and_swaps_the_plate() -> void:
	_publish(_view("loc_hall", "dim"))
	var screen: Exploration = _screen()
	screen.plate_fade_seconds = 0.05
	await wait_until(func() -> bool: return _plate_shown(screen, HALL_DIM), 5.0)

	_publish(_view("loc_hall", "bright"))

	assert_true(screen.is_plate_fading(), "lighting change fades")
	assert_true(_plate_shown(screen, HALL_DIM), "old plate until the screen is black")
	await wait_until(func() -> bool: return not screen.is_plate_fading(), 2.0)
	await wait_until(func() -> bool: return _plate_shown(screen, HALL_BRIGHT), 5.0)
	assert_true(_plate_shown(screen, HALL_BRIGHT))
	assert_almost_eq((_part(screen, "PlateFade") as ColorRect).color.a, 0.0, 0.001)


func test_moving_to_another_location_swaps_without_a_fade() -> void:
	_publish(_view("loc_hall", "dim"))
	var screen: Exploration = _screen()
	await wait_until(func() -> bool: return _plate_shown(screen, HALL_DIM), 5.0)

	_publish(_view("loc_treatment", "dim"))

	assert_false(screen.is_plate_fading())
	assert_eq(screen.get_plate_path(), ArtLibrary.plate_path("sanatorium_winter", "loc_treatment", "dim"))


func test_cache_holds_the_location_its_neighbours_and_portraits_only() -> void:
	_publish(_view("loc_hall", "dim", ["head_doctor.m1"] as Array[String]))
	var screen: Exploration = _screen()
	var library: ArtLibrary = screen.get_art_library()
	await wait_until(func() -> bool: return library.cached_paths().has(DOCTOR), 5.0)
	await wait_until(func() -> bool: return library.cached_paths().has(HALL_BRIGHT), 5.0)

	for path: String in library.cached_paths():
		assert_true(path in [HALL_DIM, HALL_BRIGHT, DOCTOR], "%s belongs to the screen" % path)

	_publish(_view("loc_lobby", "bright"))
	assert_eq(library.cached_paths(), [] as Array[String], "left location and portraits released")


func test_portraits_are_framed_and_missing_ones_are_silhouettes() -> void:
	var refs: Array[String] = ["head_doctor.m1", ""]
	_publish(_view("loc_hall", "dim", refs))
	var screen: Exploration = _screen()
	var frames: Array[PortraitFrame] = _frames(_part(screen, "Characters"))
	assert_eq(frames.size(), 2, "one frame per present character")
	await wait_until(func() -> bool: return frames[0].has_portrait(), 5.0)

	assert_true(frames[0].has_portrait())
	assert_eq(frames[0].get_photo().texture.resource_path, DOCTOR)
	assert_eq(frames[0].get_display_scale(), ArtLibrary.PORTRAIT_SCALE)
	assert_eq(frames[0].texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_false(frames[1].has_portrait(), "empty portraitRef")
	assert_eq(frames[1].get_photo().texture, PortraitFrame.silhouette())


func test_unknown_or_malformed_portrait_refs_show_silhouettes_without_errors() -> void:
	var refs: Array[String] = ["nurse.f9", "portrait_doctor_01"]
	_publish(_view("loc_hall", "dim", refs))
	var screen: Exploration = _screen()
	await wait_process_frames(2)

	for frame: PortraitFrame in _frames(_part(screen, "Characters")):
		assert_false(frame.has_portrait())
		assert_eq(frame.get_photo().texture, PortraitFrame.silhouette())


func test_art_depends_only_on_location_id_lighting_and_portrait_ref() -> void:
	var view: Dictionary = _view("loc_hall", "dim", ["head_doctor.m1", ""] as Array[String])
	_publish(view)
	var screen: Exploration = _screen()
	var plate: String = screen.get_plate_path()

	# Everything else in the view changes: names, demeanor, hotspots, exits, actions.
	var other: Dictionary = view.duplicate(true)
	var location: Dictionary = other["location"]
	location["name"] = "Другое"
	location["hotspots"] = []
	location["exits"] = []
	other["availableActions"] = []
	for character: Variant in other["presentCharacters"] as Array:
		(character as Dictionary)["demeanor"] = "в панике"
		(character as Dictionary)["name"] = "Кто-то"
	_publish(other)

	assert_eq(screen.get_plate_path(), plate)
	assert_eq(plate, ArtLibrary.plate_path("sanatorium_winter", "loc_hall", "dim"))
	var frames: Array[PortraitFrame] = _frames(_part(screen, "Characters"))
	assert_false(frames[1].has_portrait(), "no portraitRef: the same silhouette as anyone else")


func test_scenario_route_param_selects_the_art_set() -> void:
	_publish(_view("loc_hall", "dim"))
	var screen: Exploration = _screen({"scenario": "other_scenario"})
	await wait_process_frames(2)

	assert_eq(screen.get_art_library().get_scenario(), "other_scenario")
	assert_false(_image(screen).visible, "that scenario has no art: placeholder")
