extends RefCounted
## PlayerView fixtures of @hs/protocol for the Exploration preview mode: the screen opens from the
## editor (run the scene) or with the route param `{"preview": "<name>"}` without a session
## server. The fixtures are read from the monorepo, so the preview works in a source checkout
## only; an exported build shows the empty state instead.

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const ReadOnly = preload("res://src/util/read_only.gd")

## packages/protocol/fixtures/views relative to the Godot project directory (apps/desktop).
const FIXTURES_DIR: String = "../../packages/protocol/fixtures/views"
const FILE_PATTERN: String = "player-view.%s.json"
const NAMES: Array[String] = ["start", "mid", "capture", "end"]
const DEFAULT_NAME: String = "mid"


static func path_for(fixture_name: String) -> String:
	var project_dir: String = ProjectSettings.globalize_path("res://")
	return project_dir.path_join(FIXTURES_DIR).simplify_path().path_join(FILE_PATTERN % fixture_name)


## The read-only PlayerView of fixture [param fixture_name]; empty (with a warning) if the name is
## unknown, the file is missing or unreadable, or it carries a server-only field.
static func load_view(fixture_name: String) -> Dictionary:
	if not NAMES.has(fixture_name):
		push_warning("Exploration preview: unknown fixture '%s'" % fixture_name)
		return ReadOnly.empty()
	var path: String = path_for(fixture_name)
	if not FileAccess.file_exists(path):
		push_warning("Exploration preview: fixture not found at %s" % path)
		return ReadOnly.empty()
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not parsed is Dictionary:
		push_warning("Exploration preview: %s is not a PlayerView object" % path)
		return ReadOnly.empty()
	var leaked: String = GameStoreScript.find_forbidden_key(parsed)
	if not leaked.is_empty():
		push_warning("Exploration preview: %s carries the server-only field '%s'" % [path, leaked])
		return ReadOnly.empty()
	return ReadOnly.freeze(parsed)
