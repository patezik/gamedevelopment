extends GutTest
## Smoke test of the HUD scene: it loads, enters the tree next to the real autoloads and shows the
## empty state without errors.

const HUD_PATH: String = "res://src/scenes/hud/hud.tscn"
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const HudScript = preload("res://src/scenes/hud/hud.gd")
const LABELS: Array[String] = [
	"ClockLabel",
	"PeriodLabel",
	"RemainingLabel",
	"HealthLabel",
	"SanityLabel",
	"FatigueLabel",
	"StaticLabel",
	"PhoneLabel",
	"BatteryLabel",
]
const BARS: Array[String] = ["HealthBar", "SanityBar", "FatigueBar", "StaticBar"]


func test_hud_scene_loads_and_instantiates() -> void:
	assert_true(ResourceLoader.exists(HUD_PATH))
	var scene: PackedScene = load(HUD_PATH) as PackedScene
	assert_not_null(scene)
	var hud: Node = scene.instantiate()
	assert_true(hud is HudScript)
	add_child_autofree(hud)

	for unique_name: String in LABELS:
		assert_true(hud.get_node_or_null("%" + unique_name) is Label, unique_name)
	for unique_name: String in BARS:
		assert_true(hud.get_node_or_null("%" + unique_name) is ProgressBar, unique_name)
	var control: Control = hud as Control
	assert_eq(control.mouse_filter, Control.MOUSE_FILTER_IGNORE, "the overlay lets input through")


func test_hud_follows_the_game_store_autoload() -> void:
	var autoload: GameStoreScript = get_tree().root.get_node_or_null(^"GameStore") as GameStoreScript
	assert_not_null(autoload, "GameStore autoload")
	if autoload == null:
		return
	var hud: Node = (load(HUD_PATH) as PackedScene).instantiate()
	add_child_autofree(hud)

	assert_true(autoload.view_changed.is_connected(Callable(hud, "_on_view_changed")))
