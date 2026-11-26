extends GutTest
## ArtLibrary (art-direction.md §7.2, §7.4): paths from PlayerView ids only, background loading,
## a silent `null` for missing art and a cache limited to what the screen retains. PortraitFrame:
## the framed portrait at an integer scale with nearest filtering and the shared silhouette.

const ArtLibrary = preload("res://src/ui/art_library.gd")
const PortraitFrame = preload("res://src/ui/portrait_frame.gd")

const SCENARIO: String = "sanatorium_winter"
const HALL_DIM: String = "res://assets/art/scenarios/sanatorium_winter/locations/loc_hall.dim.png"
const HALL_BRIGHT: String = "res://assets/art/scenarios/sanatorium_winter/locations/loc_hall.bright.png"
const DOCTOR: String = "res://assets/art/scenarios/sanatorium_winter/portraits/head_doctor.m1.png"


func _library() -> ArtLibrary:
	var library: ArtLibrary = ArtLibrary.new()
	add_child_autofree(library)
	return library


## Waits until [param path] stops loading (the texture is ready or known to be missing).
func _settle(library: ArtLibrary, path: String) -> void:
	await wait_until(func() -> bool: return not library.is_loading(path), 5.0)


# --- paths --------------------------------------------------------------------------------------


func test_plate_path_comes_from_location_id_and_lighting() -> void:
	assert_eq(ArtLibrary.plate_path(SCENARIO, "loc_hall", "dim"), HALL_DIM)
	assert_eq(
		ArtLibrary.plate_path(SCENARIO, "loc_lake_path", "dark"),
		"res://assets/art/scenarios/sanatorium_winter/locations/loc_lake_path.dark.png"
	)


func test_plate_path_rejects_unknown_lighting_and_malformed_ids() -> void:
	for bad: Array in [
		["loc_hall", ""], ["loc_hall", "noon"], ["loc_hall", "Dim"],
		["", "dim"], ["Loc_Hall", "dim"], ["../ui/frames/photo_frame", "dim"],
		["loc hall", "dim"], ["loc_hall.dim", "dim"], ["loc-hall", "dim"],
	]:
		assert_eq(ArtLibrary.plate_path(SCENARIO, str(bad[0]), str(bad[1])), "", str(bad))
	assert_eq(ArtLibrary.plate_path("../secret", "loc_hall", "dim"), "")
	assert_eq(ArtLibrary.plate_path(SCENARIO, "x".repeat(65), "dim"), "", "longer than an id")


func test_portrait_path_comes_from_portrait_ref() -> void:
	assert_eq(ArtLibrary.portrait_path(SCENARIO, "head_doctor.m1"), DOCTOR)
	assert_eq(
		ArtLibrary.portrait_path(SCENARIO, "nurse.f12"),
		"res://assets/art/scenarios/sanatorium_winter/portraits/nurse.f12.png"
	)


func test_empty_or_malformed_portrait_ref_has_no_path() -> void:
	for bad: String in [
		"", "head_doctor", "portrait_doctor_01", "head_doctor.m1.png", "head_doctor.1m",
		"head_doctor.m", "head_doctor.M1", "../head_doctor.m1", "head/doctor.m1", ".m1",
	]:
		assert_eq(ArtLibrary.portrait_path(SCENARIO, bad), "", "'%s'" % bad)


func test_scenario_defaults_to_the_mvp_one_and_rejects_bad_ids() -> void:
	var library: ArtLibrary = _library()
	assert_eq(library.get_scenario(), ArtLibrary.DEFAULT_SCENARIO)
	library.set_scenario("../../etc")
	assert_eq(library.get_scenario(), ArtLibrary.DEFAULT_SCENARIO)
	library.set_scenario("other_scenario")
	assert_eq(library.plate("loc_hall", "dim"), ArtLibrary.plate_path("other_scenario", "loc_hall", "dim"))


func test_existing_plates_lists_only_the_drawn_lighting_levels() -> void:
	var library: ArtLibrary = _library()
	assert_eq(library.existing_plates("loc_hall"), [HALL_BRIGHT, HALL_DIM] as Array[String])
	assert_eq(library.existing_plates("loc_lobby"), [] as Array[String], "no art for this location")


# --- loading ------------------------------------------------------------------------------------


func test_request_loads_in_the_background_and_signals_once_ready() -> void:
	var library: ArtLibrary = _library()
	watch_signals(library)

	var first: Texture2D = library.request(HALL_DIM)
	if first == null:
		assert_true(library.is_loading(HALL_DIM), "loads in the background")
		await _settle(library, HALL_DIM)
		assert_signal_emitted_with_parameters(library, "art_changed", [HALL_DIM])

	var texture: Texture2D = library.get_texture(HALL_DIM)
	assert_not_null(texture)
	assert_eq(Vector2i(texture.get_size()), ArtLibrary.PLATE_SIZE)
	assert_false(library.is_missing(HALL_DIM))
	assert_eq(library.request(HALL_DIM), texture, "a cached texture comes back at once")


func test_missing_file_is_a_silent_null() -> void:
	var library: ArtLibrary = _library()
	var path: String = library.plate("loc_lobby", "bright")

	assert_null(library.request(path))
	assert_true(library.is_missing(path))
	assert_false(library.is_loading(path))
	assert_null(library.get_texture(path))
	assert_null(library.request(""), "an empty path is no request")
	assert_true(library.is_missing(""))


func test_retain_keeps_only_the_current_set_in_the_cache() -> void:
	var library: ArtLibrary = _library()
	for path: String in [HALL_DIM, DOCTOR]:
		library.request(path)
		await _settle(library, path)
	assert_eq(library.cached_paths().size(), 2)

	library.retain([DOCTOR] as Array[String])

	assert_eq(library.cached_paths(), [DOCTOR] as Array[String])
	assert_null(library.get_texture(HALL_DIM), "released")


func test_load_finished_after_release_is_not_cached() -> void:
	var library: ArtLibrary = _library()
	watch_signals(library)
	if library.request(HALL_BRIGHT) != null:
		pass_test("already cached by the engine: nothing in flight to drop")
		return
	library.retain([] as Array[String])
	await _settle(library, HALL_BRIGHT)

	assert_null(library.get_texture(HALL_BRIGHT))
	assert_signal_not_emitted(library, "art_changed")


func test_changing_the_scenario_drops_the_cache() -> void:
	var library: ArtLibrary = _library()
	library.request(HALL_DIM)
	await _settle(library, HALL_DIM)
	library.set_scenario("other_scenario")
	assert_eq(library.cached_paths().size(), 0)


# --- portrait frame -----------------------------------------------------------------------------


func test_portrait_frame_draws_at_integer_scale_with_nearest_filter() -> void:
	var frame: PortraitFrame = PortraitFrame.new()
	add_child_autofree(frame)
	var texture: Texture2D = load(DOCTOR) as Texture2D
	frame.show_portrait(texture)

	assert_true(frame.has_portrait())
	assert_eq(frame.get_photo().texture, texture)
	assert_eq(frame.texture_filter, CanvasItem.TEXTURE_FILTER_NEAREST)
	assert_eq(frame.get_display_scale(), ArtLibrary.PORTRAIT_SCALE)
	var outer: Vector2 = Vector2(ArtLibrary.PORTRAIT_SIZE + Vector2i.ONE * ArtLibrary.FRAME_MARGIN * 2)
	assert_eq(frame.custom_minimum_size, outer * ArtLibrary.PORTRAIT_SCALE)
	assert_not_null(frame.get_frame().texture, "photo_frame.png is the 9-slice")
	assert_false(frame.get_frame().draw_center)

	frame.set_display_scale(3)
	assert_eq(frame.custom_minimum_size, outer * 3)


func test_portrait_frame_without_texture_shows_the_shared_silhouette() -> void:
	var first: PortraitFrame = PortraitFrame.new()
	var second: PortraitFrame = PortraitFrame.new()
	add_child_autofree(first)
	add_child_autofree(second)
	first.show_portrait(null)

	assert_false(first.has_portrait())
	assert_eq(first.get_photo().texture, PortraitFrame.silhouette())
	assert_eq(second.get_photo().texture, first.get_photo().texture, "one placeholder for everyone")
	assert_eq(Vector2i(PortraitFrame.silhouette().get_size()), ArtLibrary.PORTRAIT_SIZE)
