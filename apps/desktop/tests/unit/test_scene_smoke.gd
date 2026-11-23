extends GutTest
## Smoke (godot-client.md §6): every scene under res://src/scenes loads, instantiates and enters
## the tree without errors.

const SCENES_DIR: String = "res://src/scenes"


static func _scene_paths(directory: String) -> PackedStringArray:
	var found: PackedStringArray = PackedStringArray()
	var dir: DirAccess = DirAccess.open(directory)
	if dir == null:
		return found
	for file_name: String in dir.get_files():
		if file_name.get_extension() == "tscn":
			found.append(directory.path_join(file_name))
	for child: String in dir.get_directories():
		found.append_array(_scene_paths(directory.path_join(child)))
	found.sort()
	return found


func test_scene_list_includes_the_known_screens() -> void:
	var paths: PackedStringArray = _scene_paths(SCENES_DIR)
	assert_has(paths, "res://src/scenes/bootstrap.tscn")
	assert_has(paths, "res://src/scenes/exploration/exploration.tscn")


func test_every_scene_loads_and_enters_the_tree() -> void:
	for path: String in _scene_paths(SCENES_DIR):
		var packed: PackedScene = load(path) as PackedScene
		assert_not_null(packed, "%s loads" % path)
		if packed == null:
			continue
		var node: Node = packed.instantiate()
		assert_not_null(node, "%s instantiates" % path)
		if node != null:
			add_child_autofree(node)
			assert_true(node.is_inside_tree(), "%s enters the tree" % path)
