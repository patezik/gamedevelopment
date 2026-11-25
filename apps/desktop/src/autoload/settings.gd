extends Node
## Settings: the player's preferences on this computer, kept in a ConfigFile under user://.
##
## For now it holds one accessibility switch, «Снизить визуальные эффекты»
## ([method set_reduce_visual_effects]): when it is on, the horror screen effects are off
## (godot-client.md §7). A missing file means the defaults; an unreadable file or a value of the
## wrong type falls back to the default with a warning and is never fatal.

## «Снизить визуальные эффекты» was switched on or off.
signal reduce_visual_effects_changed(enabled: bool)

const DEFAULT_PATH: String = "user://settings.cfg"
const SECTION_ACCESSIBILITY: String = "accessibility"
const KEY_REDUCE_VISUAL_EFFECTS: String = "reduce_visual_effects"

## Where the settings live; tests point it at a scratch file before [method load_settings].
var config_path: String = DEFAULT_PATH

var _reduce_visual_effects: bool = false


func _ready() -> void:
	load_settings()


## Reads [member config_path]. Without a file the defaults apply and OK is returned; another
## read error keeps the defaults, warns and returns that error.
func load_settings() -> Error:
	var config: ConfigFile = ConfigFile.new()
	var error: Error = config.load(config_path)
	var reduce: bool = false
	if error == OK:
		var value: Variant = config.get_value(SECTION_ACCESSIBILITY, KEY_REDUCE_VISUAL_EFFECTS, false)
		if value is bool:
			reduce = value
		else:
			push_warning("Settings: '%s' is not a bool, the default is used" % KEY_REDUCE_VISUAL_EFFECTS)
	elif error == ERR_FILE_NOT_FOUND:
		error = OK
	else:
		push_warning("Settings: %s could not be read (%s), defaults are used" % [
			config_path, error_string(error)
		])
	_apply_reduce_visual_effects(reduce)
	return error


## Writes the current settings to [member config_path].
func save_settings() -> Error:
	var config: ConfigFile = ConfigFile.new()
	config.set_value(SECTION_ACCESSIBILITY, KEY_REDUCE_VISUAL_EFFECTS, _reduce_visual_effects)
	var error: Error = config.save(config_path)
	if error != OK:
		push_warning("Settings: %s could not be written (%s)" % [config_path, error_string(error)])
	return error


func get_reduce_visual_effects() -> bool:
	return _reduce_visual_effects


## Switches «Снизить визуальные эффекты» and saves the settings when the value changes.
func set_reduce_visual_effects(enabled: bool) -> Error:
	if enabled == _reduce_visual_effects:
		return OK
	_apply_reduce_visual_effects(enabled)
	return save_settings()


func _apply_reduce_visual_effects(enabled: bool) -> void:
	if enabled == _reduce_visual_effects:
		return
	_reduce_visual_effects = enabled
	reduce_visual_effects_changed.emit(enabled)
