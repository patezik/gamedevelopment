extends Control
## Manual check of the Exploration art (GDT-012): the real Exploration scene fed with the `start`
## PlayerView fixture moved to a location with reference art, the present characters given
## portraitRef values (one empty, one with no file). Not part of the game and not run by GUT.
##
## Run from the editor (F6) or:
##   godot --path apps/desktop res://tests/manual/exploration_art_preview.tscn -- --location=loc_hall --lighting=dim
## `--portraits=head_doctor.m1,,nurse.f9` sets portraitRef in order (empty — none);
## `--relight=bright` changes the lighting after the first frame to show the dip to black;
## `--capture=<file.png>` renders a fixed 1920×1080 SubViewport, saves it and quits.

const ExplorationScene = preload("res://src/scenes/exploration/exploration.tscn")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const SCREEN: Vector2i = Vector2i(1920, 1080)

var _location: String = "loc_hall"
var _lighting: String = "dim"
var _relight: String = ""
var _portraits: PackedStringArray = PackedStringArray(["nurse.f1", "head_doctor.m1", ""])
var _capture: String = ""
var _store: GameStoreScript = null
var _version: int = 0


func _ready() -> void:
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--location="):
			_location = arg.trim_prefix("--location=")
		elif arg.begins_with("--lighting="):
			_lighting = arg.trim_prefix("--lighting=")
		elif arg.begins_with("--relight="):
			_relight = arg.trim_prefix("--relight=")
		elif arg.begins_with("--portraits="):
			_portraits = arg.trim_prefix("--portraits=").split(",")
		elif arg.begins_with("--capture="):
			_capture = arg.trim_prefix("--capture=")
	_store = GameStoreScript.new()
	add_child(_store)
	var host: Node = self
	var viewport: SubViewport = null
	if not _capture.is_empty():
		viewport = SubViewport.new()
		viewport.size = SCREEN
		viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		add_child(viewport)
		var root: Control = Control.new()
		root.size = Vector2(SCREEN)
		viewport.add_child(root)
		host = root
	_publish(_lighting)
	var screen: Control = ExplorationScene.instantiate() as Control
	screen.set("plate_fade_seconds", 0.6)
	screen.call("bind_store", _store)
	host.add_child(screen)
	if not _relight.is_empty():
		await get_tree().create_timer(1.0).timeout
		_publish(_relight)
	if viewport == null:
		return
	await get_tree().create_timer(2.0).timeout
	for i: int in 2:
		await RenderingServer.frame_post_draw
	var error: Error = viewport.get_texture().get_image().save_png(_capture)
	print("exploration_art_preview: saved %s (%s)" % [_capture, error_string(error)])
	get_tree().quit(0 if error == OK else 1)


func _publish(lighting: String) -> void:
	# The fixture's own location id is renamed everywhere (location, map), so the screen stays
	# consistent with the art it shows.
	var fixture: Dictionary = PreviewFixtures.load_view("start")
	var fixture_id: String = str((fixture["location"] as Dictionary)["id"])
	var json: String = JSON.stringify(fixture).replace('"%s"' % fixture_id, '"%s"' % _location)
	var view: Dictionary = JSON.parse_string(json) as Dictionary
	var location: Dictionary = view["location"]
	location["lighting"] = lighting
	var characters: Array = view["presentCharacters"]
	for index: int in _portraits.size():
		if index >= characters.size():
			characters.append((characters[0] as Dictionary).duplicate(true))
			(characters[index] as Dictionary)["id"] = "ch_extra_%d" % index
			(characters[index] as Dictionary)["name"] = "Посетитель %d" % index
		(characters[index] as Dictionary)["portraitRef"] = _portraits[index]
	_version += 1
	_store.set_view(view, _version)
