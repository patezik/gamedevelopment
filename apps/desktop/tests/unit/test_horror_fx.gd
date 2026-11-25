extends GutTest

const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const SettingsScript = preload("res://src/autoload/settings.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")
const HorrorFxScene = preload("res://src/scenes/overlays/horror_fx/horror_fx.tscn")
const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const ROUTED_SCREEN: String = "res://tests/unit/support/routed_screen.tscn"
const CONFIG_PATH: String = "user://test_settings_horror_fx.cfg"

var _backend: FakeBackend
var _store: GameStoreScript
var _settings: SettingsScript
var _fx: HorrorFx
var _version: int = 0


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	_settings = SettingsScript.new()
	_settings.config_path = CONFIG_PATH
	add_child_autofree(_settings)
	_fx = HorrorFxScene.instantiate() as HorrorFx
	_fx.bind_settings(_settings)
	_fx.bind_store(_store)
	add_child_autofree(_fx)
	_version = 0


func after_each() -> void:
	if FileAccess.file_exists(CONFIG_PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(CONFIG_PATH))


func _view(sanity: Variant, level: Variant) -> Dictionary:
	var view: Dictionary = {"clock": {"period": "night"}}
	if sanity != null:
		view["vitals"] = {"health": 10, "sanity": sanity, "fatigue": 0}
	if level != null:
		view["static"] = level
	return view


func _push(sanity: Variant, level: Variant) -> void:
	_version += 1
	assert_true(_store.set_view(_view(sanity, level), _version))


func _effect() -> ColorRect:
	return _fx.get_node("%Effect") as ColorRect


func _uniform(name: StringName) -> float:
	var material: ShaderMaterial = _effect().material as ShaderMaterial
	return material.get_shader_parameter(name) as float


func test_strength_follows_sanity_and_static_thresholds() -> void:
	assert_eq(HorrorFx.distortion_for(_view(10, 0)), 0.0, "calm mind")
	assert_eq(HorrorFx.distortion_for(_view(6, 0)), 0.0, "above the onset")
	assert_almost_eq(HorrorFx.distortion_for(_view(5, 0)), HorrorFx.ONSET_STRENGTH, 0.0001)
	assert_almost_eq(HorrorFx.distortion_for(_view(0, 0)), 1.0, 0.0001)
	assert_true(HorrorFx.distortion_for(_view(2, 0)) > HorrorFx.distortion_for(_view(4, 0)))
	assert_eq(HorrorFx.noise_for(_view(10, 24)), 0.0, "below the first threshold")
	assert_almost_eq(HorrorFx.noise_for(_view(10, 25)), HorrorFx.ONSET_STRENGTH, 0.0001)
	assert_almost_eq(HorrorFx.noise_for(_view(10, 100)), 1.0, 0.0001)
	assert_true(HorrorFx.noise_for(_view(10, 80)) > HorrorFx.noise_for(_view(10, 40)))


func test_missing_or_malformed_values_mean_no_effect() -> void:
	assert_eq(HorrorFx.distortion_for({}), 0.0)
	assert_eq(HorrorFx.noise_for({}), 0.0)
	assert_eq(HorrorFx.distortion_for(_view(null, null)), 0.0)
	assert_eq(HorrorFx.distortion_for(_view("low", "high")), 0.0)
	assert_eq(HorrorFx.noise_for(_view(1.5, 60.5)), 0.0)
	assert_eq(HorrorFx.distortion_for({"vitals": "broken"}), 0.0)
	assert_almost_eq(HorrorFx.distortion_for(_view(-3.0, 0)), 1.0, 0.0001, "JSON floats are read")


func test_hidden_without_a_view_and_shown_for_a_troubled_one() -> void:
	assert_false(_fx.is_effect_visible(), "no view yet")
	_push(9, 10)
	_fx.finish_transition()
	assert_false(_fx.is_effect_visible(), "nothing to show")
	_push(3, 60)
	_fx.finish_transition()
	assert_true(_fx.is_effect_visible())
	assert_almost_eq(_uniform(HorrorFx.UNIFORM_DISTORTION), HorrorFx.distortion_for(_view(3, 60)), 0.0001)
	assert_almost_eq(_uniform(HorrorFx.UNIFORM_NOISE), HorrorFx.noise_for(_view(3, 60)), 0.0001)


func test_a_new_view_blends_in_over_real_time() -> void:
	_push(0, 100)
	assert_eq(_fx.get_distortion(), 0.0, "the blend starts from the previous state")
	assert_true(_fx.is_processing())
	await wait_seconds(0.3)
	assert_between(_fx.get_distortion(), 0.01, 0.99)
	_fx.finish_transition()
	assert_eq(_fx.get_distortion(), 1.0)
	assert_eq(_fx.get_noise(), 1.0)


func test_reduce_visual_effects_turns_the_effect_off_and_back_on() -> void:
	_push(1, 90)
	_fx.finish_transition()
	assert_true(_fx.is_effect_visible())

	_settings.set_reduce_visual_effects(true)
	assert_true(_fx.is_reduced())
	assert_false(_fx.is_effect_visible(), "the setting hides the effect")
	assert_false(_fx.is_processing(), "nothing runs while reduced")
	assert_eq(_uniform(HorrorFx.UNIFORM_DISTORTION), 0.0)
	assert_eq(_uniform(HorrorFx.UNIFORM_NOISE), 0.0)
	_push(0, 100)
	assert_false(_fx.is_effect_visible(), "new views stay without effects")

	_settings.set_reduce_visual_effects(false)
	_fx.finish_transition()
	assert_true(_fx.is_effect_visible())


func test_a_reduced_setting_applies_from_the_start() -> void:
	_settings.set_reduce_visual_effects(true)
	var fx: HorrorFx = HorrorFxScene.instantiate() as HorrorFx
	fx.bind_settings(_settings)
	fx.bind_store(_store)
	add_child_autofree(fx)
	_push(0, 100)
	fx.finish_transition()
	assert_false(fx.is_effect_visible())


func test_the_session_ending_clears_the_effect() -> void:
	_push(0, 100)
	_fx.finish_transition()
	_backend.change_state(BackendScript.ConnectionState.CONNECTING)
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_fx.finish_transition()
	assert_false(_fx.is_effect_visible())
	assert_eq(_fx.get_target_distortion(), 0.0)


func test_a_view_with_server_truth_is_ignored() -> void:
	var view: Dictionary = _view(0, 100)
	view["truth"] = {"culprit": "x"}
	_fx.show_view(view)
	_fx.finish_transition()
	assert_false(_fx.is_effect_visible())


func test_the_overlay_lets_input_through_and_sits_below_the_curtain() -> void:
	assert_eq(_effect().mouse_filter, Control.MOUSE_FILTER_IGNORE)
	assert_eq(_fx.layer, HorrorFx.OVERLAY_LAYER)
	assert_true(HorrorFx.OVERLAY_LAYER < DebugOverlay.OVERLAY_LAYER)


func test_install_adds_one_overlay_that_survives_screen_changes() -> void:
	# The game installs the overlay on the root and SceneRouter swaps screens beside it.
	var root: Node = Node.new()
	add_child_autofree(root)
	var screens: Node = Node.new()
	root.add_child(screens)
	var router: SceneRouterScript = SceneRouterScript.new()
	add_child_autofree(router)
	router.host = screens
	router.fade_seconds = 0.0
	router.register_screen(&"alpha", ROUTED_SCREEN)
	router.register_screen(&"beta", ROUTED_SCREEN)

	var installed: HorrorFx = HorrorFx.install(root)
	await wait_physics_frames(2)
	assert_eq(HorrorFx.install(root), installed, "a second install reuses the overlay")
	assert_true(installed.is_inside_tree())
	installed.bind_settings(_settings)
	installed.bind_store(_store)
	_push(2, 70)
	installed.finish_transition()

	for screen: StringName in [&"alpha", &"beta", &"alpha"]:
		assert_eq(router.goto(screen), OK)
		await wait_until(func() -> bool: return not router.is_transitioning(), 2.0)
		assert_true(is_instance_valid(installed) and installed.is_inside_tree(), "after %s" % screen)
		assert_true(installed.is_effect_visible(), "the effect keeps up after %s" % screen)
	assert_eq(screens.get_child_count(), 1)
	assert_null(HorrorFx.install(null))
