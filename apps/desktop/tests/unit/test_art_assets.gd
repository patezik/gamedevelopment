extends GutTest
## Reference art of CNT-010 (art-direction.md §7): every registered asset imports as an
## uncompressed texture without mipmaps at the size of its category. Pixel rules (palette,
## alpha, naming, provenance) are checked by `npm run art:check`.

const ART_ROOT: String = "res://assets/art/"
const PROVENANCE: String = "res://assets/art/provenance.json"
const SIZES: Dictionary = {
	"location": Vector2i(384, 216),
	"portrait": Vector2i(96, 128),
}


func _assets() -> Array[Dictionary]:
	var text: String = FileAccess.get_file_as_string(PROVENANCE)
	var parsed: Variant = JSON.parse_string(text)
	var result: Array[Dictionary] = []
	if parsed is Dictionary and (parsed as Dictionary).get("assets") is Array:
		for entry: Variant in (parsed as Dictionary)["assets"] as Array:
			if entry is Dictionary:
				result.append(entry as Dictionary)
	return result


func test_registry_lists_the_reference_set() -> void:
	var locations: Dictionary = {}
	var portraits: int = 0
	for entry: Dictionary in _assets():
		var kind: String = str(entry.get("kind", ""))
		if kind == "location":
			locations[str(entry["path"]).get_file().get_slice(".", 0)] = true
		elif kind == "portrait":
			portraits += 1
	assert_gte(locations.size(), 3, "three reference locations")
	assert_gte(portraits, 2, "two reference portraits")


func test_assets_import_as_lossless_textures_of_their_category_size() -> void:
	var assets: Array[Dictionary] = _assets()
	assert_gt(assets.size(), 0, "provenance.json lists assets")
	for entry: Dictionary in assets:
		var path: String = ART_ROOT + str(entry["path"])
		var texture: Texture2D = load(path) as Texture2D
		assert_not_null(texture, "%s loads as Texture2D" % path)
		if texture == null:
			continue
		var image: Image = texture.get_image()
		assert_false(image.has_mipmaps(), "%s has no mipmaps" % path)
		assert_false(image.is_compressed(), "%s is lossless" % path)
		var kind: String = str(entry.get("kind", ""))
		if SIZES.has(kind):
			assert_eq(Vector2i(texture.get_width(), texture.get_height()), SIZES[kind] as Vector2i, path)
