extends SceneTree
## Manual FPS measurement of the horror effects (GDT-010, godot-client.md §7.4). Not part of GUT.
##
## Mounts the Exploration screen with the `mid` PlayerView fixture, the HUD on top and the
## HorrorFx overlay on the root, pushes the fixture into GameStore with chosen sanity and Static
## (by default 0 and 100: the strongest effect) and measures real frame times after a warm-up.
## It prints the adapter, rendering driver and method, window size, VSync mode, effect state,
## average FPS, 1 % low FPS and frame-time percentiles.
##
## Run from the repository root (a window opens; the GPU is the one Windows gives the process):
##   <godot> --path apps/desktop --script res://tests/manual/horror_fx_benchmark.gd -- \
##     [--seconds=20] [--warmup=3] [--sanity=0] [--static=100] [--reduce] [--vsync=on|off] \
##     [--window=default|maximized|fullscreen|exclusive]

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const SettingsScript = preload("res://src/autoload/settings.gd")
const PreviewFixtures = preload("res://src/scenes/exploration/preview_fixtures.gd")
const EXPLORATION: String = "res://src/scenes/exploration/exploration.tscn"
const HUD: String = "res://src/scenes/hud/hud.tscn"
const BENCH_SETTINGS: String = "user://benchmark_settings.cfg"
const VSYNC_NAMES: Dictionary = {
	DisplayServer.VSYNC_DISABLED: "disabled",
	DisplayServer.VSYNC_ENABLED: "enabled",
	DisplayServer.VSYNC_ADAPTIVE: "adaptive",
	DisplayServer.VSYNC_MAILBOX: "mailbox",
}

## `--window`: the project's own window (default), maximized, borderless or exclusive fullscreen.
const WINDOW_MODES: Dictionary = {
	"maximized": DisplayServer.WINDOW_MODE_MAXIMIZED,
	"fullscreen": DisplayServer.WINDOW_MODE_FULLSCREEN,
	"exclusive": DisplayServer.WINDOW_MODE_EXCLUSIVE_FULLSCREEN,
}

var _options: Dictionary = {
	"seconds": "20", "warmup": "3", "sanity": "0", "static": "100", "vsync": "on", "reduce": "",
	"window": "default",
}
var _frames: PackedFloat64Array = PackedFloat64Array()
var _last_usec: int = 0
var _started_usec: int = 0
var _fx: HorrorFx


func _initialize() -> void:
	for argument: String in OS.get_cmdline_user_args():
		var pair: PackedStringArray = argument.trim_prefix("--").split("=", true, 1)
		_options[pair[0]] = pair[1] if pair.size() > 1 else "1"
	DisplayServer.window_set_vsync_mode(
		DisplayServer.VSYNC_DISABLED if _options["vsync"] == "off" else DisplayServer.VSYNC_ENABLED
	)
	var mode: Variant = WINDOW_MODES.get(str(_options["window"]))
	if mode != null:
		DisplayServer.window_set_mode(mode as DisplayServer.WindowMode)
	_setup.call_deferred()


func _setup() -> void:
	var settings: SettingsScript = root.get_node(^"Settings") as SettingsScript
	# A scratch settings file: the player's own settings stay as they were.
	settings.config_path = BENCH_SETTINGS
	settings.set_reduce_visual_effects(not str(_options["reduce"]).is_empty())

	var screen: Node = (load(EXPLORATION) as PackedScene).instantiate()
	root.add_child(screen)
	var hud: Node = (load(HUD) as PackedScene).instantiate()
	root.add_child(hud)
	_fx = HorrorFx.install(root)

	var view: Dictionary = PreviewFixtures.load_view("mid").duplicate(true)
	var vitals: Dictionary = view.get("vitals", {}) as Dictionary
	vitals["sanity"] = str(_options["sanity"]).to_int()
	view["vitals"] = vitals
	view["static"] = str(_options["static"]).to_int()
	var store: GameStoreScript = root.get_node(^"GameStore") as GameStoreScript
	store.set_view(view, 1)

	await create_timer(0.2).timeout
	_fx.finish_transition()
	await create_timer(str(_options["warmup"]).to_float()).timeout
	_print_setup()
	_started_usec = Time.get_ticks_usec()
	_last_usec = _started_usec
	process_frame.connect(_on_frame)


func _on_frame() -> void:
	var now: int = Time.get_ticks_usec()
	_frames.append(float(now - _last_usec) / 1000.0)
	_last_usec = now
	if float(now - _started_usec) / 1_000_000.0 >= str(_options["seconds"]).to_float():
		process_frame.disconnect(_on_frame)
		_print_result(float(now - _started_usec) / 1_000_000.0)
		DirAccess.remove_absolute(ProjectSettings.globalize_path(BENCH_SETTINGS))
		quit()


func _print_setup() -> void:
	var size: Vector2i = DisplayServer.window_get_size()
	var screen: int = DisplayServer.window_get_current_screen()
	print("BENCH adapter=%s" % RenderingServer.get_video_adapter_name())
	print("BENCH vendor=%s" % RenderingServer.get_video_adapter_vendor())
	print("BENCH api=%s" % RenderingServer.get_video_adapter_api_version())
	print("BENCH driver=%s method=%s" % [
		RenderingServer.get_current_rendering_driver_name(),
		RenderingServer.get_current_rendering_method(),
	])
	print("BENCH window=%dx%d mode=%d screen=%dx%d@%.0fHz" % [
		size.x, size.y, DisplayServer.window_get_mode(),
		DisplayServer.screen_get_size(screen).x, DisplayServer.screen_get_size(screen).y,
		DisplayServer.screen_get_refresh_rate(screen),
	])
	print("BENCH vsync=%s" % VSYNC_NAMES.get(DisplayServer.window_get_vsync_mode(), "?"))
	print("BENCH reduce=%s effect_visible=%s distortion=%.2f noise=%.2f" % [
		_fx.is_reduced(), _fx.is_effect_visible(), _fx.get_distortion(), _fx.get_noise(),
	])


func _print_result(elapsed: float) -> void:
	var sorted: PackedFloat64Array = _frames.duplicate()
	sorted.sort()
	var count: int = sorted.size()
	var worst_count: int = maxi(1, int(count * 0.01))
	var worst_sum: float = 0.0
	for i: int in worst_count:
		worst_sum += sorted[count - 1 - i]
	print("BENCH frames=%d seconds=%.2f avg_fps=%.1f" % [count, elapsed, float(count) / elapsed])
	print("BENCH frame_ms avg=%.2f p50=%.2f p95=%.2f p99=%.2f max=%.2f" % [
		elapsed * 1000.0 / float(count),
		sorted[int(count * 0.5)], sorted[int(count * 0.95)], sorted[int(count * 0.99)], sorted[count - 1],
	])
	print("BENCH low1pct_fps=%.1f slowest_frame_fps=%.1f frames_over_16.7ms=%d" % [
		1000.0 / (worst_sum / float(worst_count)), 1000.0 / sorted[count - 1],
		_count_over(sorted, 1000.0 / 60.0),
	])
	var per_second: PackedInt32Array = _frames_per_second()
	var lowest: int = per_second[0] if not per_second.is_empty() else 0
	for value: int in per_second:
		lowest = mini(lowest, value)
	print("BENCH fps_per_second min=%d values=%s" % [lowest, per_second])


## Frames counted in each whole second of the measurement (what an FPS counter shows).
func _frames_per_second() -> PackedInt32Array:
	var result: PackedInt32Array = PackedInt32Array()
	var elapsed_ms: float = 0.0
	var in_second: int = 0
	for frame_ms: float in _frames:
		elapsed_ms += frame_ms
		in_second += 1
		if elapsed_ms >= 1000.0 * float(result.size() + 1):
			result.append(in_second)
			in_second = 0
	return result


static func _count_over(sorted: PackedFloat64Array, limit_ms: float) -> int:
	var over: int = 0
	for value: float in sorted:
		if value > limit_ms:
			over += 1
	return over
