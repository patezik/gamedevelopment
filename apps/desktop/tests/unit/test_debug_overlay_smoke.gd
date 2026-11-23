extends GutTest
## The overlay as the game installs it: on the scene root, bound to the real autoloads.


func test_installed_overlay_opens_with_its_controls_and_closes() -> void:
	var host: Node = Node.new()
	add_child_autofree(host)
	var overlay: DebugOverlay = DebugOverlay.install(host)
	await wait_process_frames(1)

	assert_true(overlay.is_inside_tree())
	assert_eq(overlay.layer, DebugOverlay.OVERLAY_LAYER)
	assert_true(overlay.open())
	var panel: Control = overlay.get_node("Panel") as Control
	assert_true(panel.visible)
	for button_name: String in ["CopySeedButton", "TruthButton", "RevealButton", "ExportButton", "CloseButton"]:
		assert_not_null(panel.find_child(button_name, true, false), button_name)
	assert_string_contains(overlay.get_time_text(), "Время")
	assert_false(overlay.has_session())

	overlay.close()
	assert_false(panel.visible)
