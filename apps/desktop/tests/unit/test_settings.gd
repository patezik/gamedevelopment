extends GutTest

const SettingsScript = preload("res://src/autoload/settings.gd")
const CONFIG_PATH: String = "user://test_settings_gdt010.cfg"

var _settings: SettingsScript


func before_each() -> void:
	_remove_config()
	_settings = SettingsScript.new()
	_settings.config_path = CONFIG_PATH
	add_child_autofree(_settings)


func after_each() -> void:
	_remove_config()


func _remove_config() -> void:
	if FileAccess.file_exists(CONFIG_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(CONFIG_PATH))


func test_reduce_visual_effects_is_off_without_a_file() -> void:
	assert_eq(_settings.load_settings(), OK)
	assert_false(_settings.get_reduce_visual_effects())


func test_switching_emits_once_and_saves() -> void:
	watch_signals(_settings)
	assert_eq(_settings.set_reduce_visual_effects(true), OK)
	assert_eq(_settings.set_reduce_visual_effects(true), OK)
	assert_signal_emit_count(_settings, "reduce_visual_effects_changed", 1)
	assert_true(FileAccess.file_exists(CONFIG_PATH))

	var reloaded: SettingsScript = SettingsScript.new()
	reloaded.config_path = CONFIG_PATH
	add_child_autofree(reloaded)
	assert_true(reloaded.get_reduce_visual_effects(), "the switch survives a restart")


func test_a_value_of_the_wrong_type_falls_back_to_the_default() -> void:
	var config: ConfigFile = ConfigFile.new()
	config.set_value(SettingsScript.SECTION_ACCESSIBILITY, SettingsScript.KEY_REDUCE_VISUAL_EFFECTS, "yes")
	assert_eq(config.save(CONFIG_PATH), OK)
	assert_eq(_settings.load_settings(), OK)
	assert_false(_settings.get_reduce_visual_effects())
	assert_push_warning("is not a bool")


func test_the_autoload_is_registered() -> void:
	assert_true(get_tree().root.get_node_or_null(^"Settings") is SettingsScript)
