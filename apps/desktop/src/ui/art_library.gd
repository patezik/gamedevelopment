extends Node
## Location plates and character portraits of a scenario (art-direction.md §7.2, §7.4).
##
## Paths are built only from fields the client already has: `location.id` and `location.lighting`
## of the PlayerView for a plate, `CharacterView.portraitRef` for a portrait. Anything that is not
## a well-formed id gives an empty path, so view data can never point the loader outside the art
## directory. A missing file is a normal case (the art set is incomplete until CNT-012): the
## texture stays `null`, no error is reported and the screen keeps its placeholder.
##
## Textures load on demand in the background (`ResourceLoader.load_threaded_request`) and
## [signal art_changed] fires when one is ready or found missing. The cache holds only what the
## screen asked to [method retain]: the current location, its neighbours and the portraits on
## screen.

## A requested texture finished loading ([method get_texture] returns it) or turned out missing.
signal art_changed(path: String)

const ROOT: String = "res://assets/art/"
## The only scenario of the MVP (mvp-scenario-sanatorium.md); used until a screen is told another.
const DEFAULT_SCENARIO: String = "sanatorium_winter"
const FRAME_PATH: String = ROOT + "ui/frames/photo_frame.png"
## Lighting levels of `LocationView.lighting`, in the order a plate set is listed.
const LIGHTING_LEVELS: Array[String] = ["bright", "dim", "dark"]
const PLATE_SIZE: Vector2i = Vector2i(384, 216)
const PORTRAIT_SIZE: Vector2i = Vector2i(96, 128)
## Display scales (art-direction.md §5.1, §6.1): integers only, with nearest filtering.
const PLATE_SCALE: int = 3
const PORTRAIT_SCALE: int = 2
## Border of the 9-slice photo frame, in portrait pixels (art-direction.md §6.3).
const FRAME_MARGIN: int = 6
const MAX_ID_LENGTH: int = 64
const ID_CHARS: String = "abcdefghijklmnopqrstuvwxyz0123456789_"
const DIGITS: String = "0123456789"

var _scenario: String = DEFAULT_SCENARIO
var _textures: Dictionary = {}
var _pending: Dictionary = {}
var _missing: Dictionary = {}
var _retained: Dictionary = {}


func _init() -> void:
	set_process(false)


## `res://assets/art/scenarios/<scenario>/locations/<id>.<lighting>.png`, or "" when an id or the
## lighting level is not valid.
static func plate_path(scenario: String, location_id: String, lighting: String) -> String:
	if not is_id(scenario) or not is_id(location_id) or not LIGHTING_LEVELS.has(lighting):
		return ""
	return ROOT + "scenarios/%s/locations/%s.%s.png" % [scenario, location_id, lighting]


## `res://assets/art/scenarios/<scenario>/portraits/<archetype>.<variant>.png` for a
## `portraitRef` of the form `<archetype_id>.<variant>`; "" for an empty or malformed reference.
static func portrait_path(scenario: String, portrait_ref: String) -> String:
	var parts: PackedStringArray = portrait_ref.split(".")
	if not is_id(scenario) or parts.size() != 2 or not is_id(parts[0]) or not _is_variant(parts[1]):
		return ""
	return ROOT + "scenarios/%s/portraits/%s.png" % [scenario, portrait_ref]


## A `snake_case` id of content: lowercase latin letters, digits and `_`, at most 64 characters.
static func is_id(text: String) -> bool:
	if text.is_empty() or text.length() > MAX_ID_LENGTH:
		return false
	for character: String in text:
		if not ID_CHARS.contains(character):
			return false
	return true


## A portrait variant: one lowercase letter and a number (`m1`, `f2`).
static func _is_variant(text: String) -> bool:
	if text.length() < 2 or not "abcdefghijklmnopqrstuvwxyz".contains(text[0]):
		return false
	for character: String in text.substr(1):
		if not DIGITS.contains(character):
			return false
	return true


func get_scenario() -> String:
	return _scenario


## Switches the scenario whose art is shown; textures of the previous one are dropped.
func set_scenario(scenario: String) -> void:
	var next: String = scenario if is_id(scenario) else DEFAULT_SCENARIO
	if next == _scenario:
		return
	_scenario = next
	_textures.clear()
	_missing.clear()
	_retained.clear()


func plate(location_id: String, lighting: String) -> String:
	return plate_path(_scenario, location_id, lighting)


func portrait(portrait_ref: String) -> String:
	return portrait_path(_scenario, portrait_ref)


## Paths of the plates that exist for [param location_id], one per lighting level.
func existing_plates(location_id: String) -> Array[String]:
	var paths: Array[String] = []
	for level: String in LIGHTING_LEVELS:
		var path: String = plate(location_id, level)
		if not path.is_empty() and ResourceLoader.exists(path):
			paths.append(path)
	return paths


## The loaded texture of [param path] or `null` (not requested, still loading or missing).
func get_texture(path: String) -> Texture2D:
	return _textures.get(path) as Texture2D


func is_loading(path: String) -> bool:
	return _pending.has(path)


## True once [param path] is known to have no usable texture (also for an empty path).
func is_missing(path: String) -> bool:
	return path.is_empty() or _missing.has(path)


## Starts loading [param path] unless it is cached, loading or known to be missing, and keeps it
## in the cache. Returns the texture when it is already available, `null` otherwise.
func request(path: String) -> Texture2D:
	if path.is_empty():
		return null
	_retained[path] = true
	if _textures.has(path):
		return _textures[path] as Texture2D
	if _missing.has(path) or _pending.has(path):
		return null
	if not ResourceLoader.exists(path):
		_missing[path] = true
		return null
	if ResourceLoader.has_cached(path):
		var cached: Texture2D = ResourceLoader.load(path, "Texture2D") as Texture2D
		if cached != null:
			_textures[path] = cached
			return cached
	if ResourceLoader.load_threaded_request(path, "Texture2D") != OK:
		_missing[path] = true
		return null
	_pending[path] = true
	set_process(true)
	return null


## Keeps only [param paths] in the cache: other textures are released (art-direction.md §7.4).
## Loads already in flight finish and are dropped unless requested again.
func retain(paths: Array[String]) -> void:
	_retained.clear()
	for path: String in paths:
		if not path.is_empty():
			_retained[path] = true
	for path: String in _textures.keys():
		if not _retained.has(path):
			_textures.erase(path)


func cached_paths() -> Array[String]:
	var paths: Array[String] = []
	for path: String in _textures.keys():
		paths.append(path)
	return paths


func _process(_delta: float) -> void:
	poll()


## Collects finished background loads; called every frame while something is loading.
func poll() -> void:
	for path: String in _pending.keys():
		var status: ResourceLoader.ThreadLoadStatus = ResourceLoader.load_threaded_get_status(path)
		if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS:
			continue
		_pending.erase(path)
		var texture: Texture2D = null
		if status == ResourceLoader.THREAD_LOAD_LOADED:
			texture = ResourceLoader.load_threaded_get(path) as Texture2D
		if texture == null:
			_missing[path] = true
		elif _retained.has(path):
			_textures[path] = texture
		if _retained.has(path):
			art_changed.emit(path)
	set_process(not _pending.is_empty())
