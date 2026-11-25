extends GutTest

const SceneRouterScript = preload("res://src/autoload/scene_router.gd")
const RoutedScreen = preload("res://tests/unit/support/routed_screen.gd")
const SCREEN_PATH: String = "res://tests/unit/support/routed_screen.tscn"

var _host: Node
var _router: SceneRouterScript


func before_each() -> void:
	_host = Node.new()
	add_child_autofree(_host)
	_router = SceneRouterScript.new()
	add_child_autofree(_router)
	_router.host = _host
	_router.fade_seconds = 0.0
	_router.register_screen(&"alpha", SCREEN_PATH)
	_router.register_screen(&"beta", SCREEN_PATH)
	watch_signals(_router)


func _settle() -> void:
	await wait_until(func() -> bool: return not _router.is_transitioning(), 2.0)


func _mounted() -> RoutedScreen:
	assert_eq(_host.get_child_count(), 1, "exactly one screen is mounted")
	return _host.get_child(_host.get_child_count() - 1) as RoutedScreen


func _curtain_alpha() -> float:
	var curtain: ColorRect = _router.get_node(^"Curtain") as ColorRect
	return curtain.color.a


func test_bootstrap_screen_is_registered_by_default() -> void:
	assert_true(_router.has_screen(&"bootstrap"))


func test_goto_mounts_screen_behind_fade_and_passes_params() -> void:
	assert_eq(_router.goto(&"alpha", {"caseId": "c-1", "filter": {"tags": ["blood"]}}), OK)

	assert_true(_router.is_transitioning())
	assert_signal_emitted_with_parameters(_router, "transition_started", [&"alpha"])
	await _settle()

	var screen: RoutedScreen = _mounted()
	assert_eq(str(screen.params_at_ready.get("caseId")), "c-1", "params arrive before _ready")
	assert_eq(_router.get_current_screen(), &"alpha")
	assert_eq(str(_router.get_current_params().get("caseId")), "c-1")
	assert_signal_emit_count(_router, "screen_changed", 1)
	var changed: Array = get_signal_parameters(_router, "screen_changed")
	var changed_screen: StringName = changed[0]
	assert_eq(changed_screen, &"alpha")
	assert_almost_eq(_curtain_alpha(), 0.0, 0.001)
	assert_false(_router.is_transitioning())


func test_screen_receives_a_read_only_copy_of_params() -> void:
	var params: Dictionary = {"filter": {"tags": ["blood"]}}
	_router.goto(&"alpha", params)
	var filter: Dictionary = params["filter"]
	filter["tags"] = ["ink"]
	await _settle()

	var received: Dictionary = _mounted().params
	var received_filter: Dictionary = received["filter"]
	var tags: Array = received_filter["tags"]
	assert_eq(tags, ["blood"])
	assert_true(received.is_read_only())
	assert_true(received_filter.is_read_only())


func test_unknown_screen_is_refused() -> void:
	assert_eq(_router.goto(&"nowhere"), ERR_DOES_NOT_EXIST)

	assert_push_error("unknown screen")
	assert_signal_emitted_with_parameters(_router, "transition_failed", [&"nowhere", "unknown_screen"])
	assert_signal_not_emitted(_router, "transition_started")
	assert_false(_router.is_transitioning())
	assert_eq(_host.get_child_count(), 0)


func test_params_with_objects_are_refused() -> void:
	var node: Node = autofree(Node.new())

	assert_eq(_router.goto(&"alpha", {"target": node}), ERR_INVALID_PARAMETER)

	assert_push_error("plain data")
	assert_signal_emitted_with_parameters(_router, "transition_failed", [&"alpha", "invalid_params"])
	assert_false(_router.is_transitioning())


func test_register_screen_rejects_missing_scene() -> void:
	assert_eq(_router.register_screen(&"ghost", "res://missing/ghost.tscn"), ERR_INVALID_PARAMETER)

	assert_push_error("cannot register")
	assert_false(_router.has_screen(&"ghost"))


func test_repeated_goto_during_transition_is_ignored() -> void:
	assert_eq(_router.goto(&"alpha", {"n": 1}), OK)
	assert_eq(_router.goto(&"alpha", {"n": 1}), ERR_BUSY)
	await _settle()

	assert_signal_emit_count(_router, "screen_changed", 1)
	assert_eq(_host.get_child_count(), 1)


func test_overlapping_goto_runs_after_current_and_latest_wins() -> void:
	assert_eq(_router.goto(&"alpha"), OK)
	assert_eq(_router.goto(&"beta"), OK)
	assert_eq(_router.goto(&"alpha", {"n": 2}), OK)
	await _settle()

	assert_signal_emit_count(_router, "screen_changed", 2)
	assert_eq(_router.get_current_screen(), &"alpha")
	assert_eq(_mounted().params, {"n": 2})
	for parameters: Array in _signal_calls("screen_changed"):
		var screen: StringName = parameters[0]
		assert_ne(screen, &"beta", "a superseded request is never mounted")


func test_sequential_goto_replaces_previous_screen() -> void:
	_router.goto(&"alpha")
	await _settle()
	var first: RoutedScreen = _mounted()

	assert_eq(_router.goto(&"beta", {"from": "alpha"}), OK)
	await _settle()

	assert_eq(_router.get_current_screen(), &"beta")
	assert_ne(_mounted(), first)
	assert_eq(_mounted().params, {"from": "alpha"})
	await wait_process_frames(2)
	assert_false(is_instance_valid(first), "the previous screen is freed")


func test_goto_current_screen_again_remounts_it() -> void:
	_router.goto(&"alpha", {"n": 1})
	await _settle()

	assert_eq(_router.goto(&"alpha", {"n": 1}), OK)
	await _settle()

	assert_signal_emit_count(_router, "screen_changed", 2)
	assert_eq(_host.get_child_count(), 1)


func test_goto_outside_the_tree_is_not_started() -> void:
	var detached: SceneRouterScript = autofree(SceneRouterScript.new())

	assert_eq(detached.goto(&"bootstrap"), ERR_UNCONFIGURED)
	assert_false(detached.is_transitioning())


func _signal_calls(signal_name: String) -> Array:
	var calls: Array = []
	var count: int = get_signal_emit_count(_router, signal_name)
	for index: int in count:
		calls.append(get_signal_parameters(_router, signal_name, index))
	return calls


func test_terminal_route_refuses_other_screens_until_it_is_mounted() -> void:
	_router.fade_seconds = 0.05
	assert_eq(_router.goto_terminal(&"beta"), OK)
	assert_eq(_router.get_terminal_screen(), &"beta")
	assert_eq(_router.goto(&"alpha"), ERR_LOCKED)
	assert_signal_emitted_with_parameters(_router, "transition_failed", [&"alpha", "terminal_pending"])
	await _settle()
	assert_eq(_router.get_current_screen(), &"beta")
	assert_eq(_router.get_terminal_screen(), &"", "the lock ends once the screen is shown")
	assert_eq(_router.goto(&"alpha"), OK)
	await _settle()
	assert_eq(_router.get_current_screen(), &"alpha")


func test_terminal_route_replaces_a_queued_ordinary_route() -> void:
	_router.fade_seconds = 0.05
	assert_eq(_router.goto(&"alpha"), OK)
	assert_eq(_router.goto(&"alpha", {"queued": true}), OK)
	assert_eq(_router.goto_terminal(&"beta"), OK)
	await _settle()
	assert_eq(_router.get_current_screen(), &"beta")
