extends Node
## Manual FPS check of the case board (GDT-008): opens the board with the large fixture in a real
## window, measures frames while idle and while the player switches tabs and the filter and the
## case board changes, prints a report and quits. Not part of GUT (needs a window and a GPU).
##
##   <godot> --path apps/desktop res://tests/perf/case_board_fps.tscn [-- --clues=24 --seconds=6]
##
## Vsync and the FPS cap are switched off so the numbers show the headroom, not the monitor rate.

const CaseBoardScene = preload("res://src/scenes/case_board/case_board.tscn")
const CaseBoard = preload("res://src/scenes/case_board/case_board.gd")
const CaseBoardFixtures = preload("res://src/scenes/case_board/case_board_fixtures.gd")

## A frame longer than this counts as a drop below 60 FPS.
const FRAME_BUDGET_MS: float = 1000.0 / 60.0
const WARMUP_SECONDS: float = 1.0
const ACTION_EVERY_SECONDS: float = 0.5

var _clues: int = CaseBoardFixtures.DEFAULT_CLUE_COUNT
var _seconds: float = 6.0
var _board: CaseBoard
var _views: Array[Dictionary] = []
var _elapsed: float = 0.0
var _phase: String = "warmup"
var _phase_started: float = 0.0
var _next_action: float = 0.0
var _action_index: int = 0
var _idle_frames: PackedFloat64Array = PackedFloat64Array()
var _interaction_frames: PackedFloat64Array = PackedFloat64Array()
var _last_ticks: int = 0


func _ready() -> void:
	for argument: String in OS.get_cmdline_user_args():
		if argument.begins_with("--clues="):
			_clues = maxi(argument.trim_prefix("--clues=").to_int(), 1)
		elif argument.begins_with("--seconds="):
			_seconds = maxf(argument.trim_prefix("--seconds=").to_float(), 1.0)
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	_views = [CaseBoardFixtures.large_view(_clues), CaseBoardFixtures.large_view(_clues + 1)]
	_board = CaseBoardScene.instantiate() as CaseBoard
	_board.set_params({"preview": "large"})
	add_child(_board)
	_board.call(&"_show", _views[0])
	_last_ticks = Time.get_ticks_usec()


func _process(delta: float) -> void:
	var now: int = Time.get_ticks_usec()
	var frame_ms: float = float(now - _last_ticks) / 1000.0
	_last_ticks = now
	_elapsed += delta
	match _phase:
		"warmup":
			if _elapsed >= WARMUP_SECONDS:
				_start("idle")
		"idle":
			_idle_frames.append(frame_ms)
			if _elapsed - _phase_started >= _seconds / 2.0:
				_start("interaction")
		"interaction":
			_interaction_frames.append(frame_ms)
			if _elapsed >= _next_action:
				_next_action = _elapsed + ACTION_EVERY_SECONDS
				_act()
			if _elapsed - _phase_started >= _seconds / 2.0:
				_report()
				get_tree().quit(0)


func _start(phase: String) -> void:
	_phase = phase
	_phase_started = _elapsed
	_next_action = _elapsed


## Cycles the player's interactions: open the next tab, filter by the next character, and a view
## whose case board changed (one more clue).
func _act() -> void:
	var tabs: TabContainer = _board.get_node(^"%Tabs") as TabContainer
	match _action_index % 3:
		0:
			tabs.current_tab = (tabs.current_tab + 1) % tabs.get_tab_count()
		1:
			var characters: Array[String] = _board.get_characters()
			var index: int = (characters.find(_board.get_filter()) + 1) % (characters.size() + 1)
			_board.set_filter(characters[index] if index < characters.size() else CaseBoard.ALL_CHARACTERS)
		2:
			_board.call(&"_show", _views[_action_index % 2])
	_action_index += 1


func _report() -> void:
	print("CaseBoard FPS check: %d clues, renderer %s, adapter %s" % [
		_clues,
		ProjectSettings.get_setting("rendering/renderer/rendering_method"),
		RenderingServer.get_video_adapter_name(),
	])
	for phase: String in ["idle", "interaction"]:
		var frames: PackedFloat64Array = _idle_frames if phase == "idle" else _interaction_frames
		if frames.is_empty():
			continue
		var sorted: PackedFloat64Array = frames.duplicate()
		sorted.sort()
		var total: float = 0.0
		var over_budget: int = 0
		for frame_ms: float in frames:
			total += frame_ms
			if frame_ms > FRAME_BUDGET_MS:
				over_budget += 1
		var p99: float = sorted[mini(int(sorted.size() * 0.99), sorted.size() - 1)]
		print("  %s: %d frames, avg %.1f FPS (%.2f ms), p99 %.2f ms, worst %.2f ms, frames > %.1f ms: %d" % [
			phase,
			frames.size(),
			1000.0 * frames.size() / total,
			total / frames.size(),
			p99,
			sorted[sorted.size() - 1],
			FRAME_BUDGET_MS,
			over_budget,
		])
