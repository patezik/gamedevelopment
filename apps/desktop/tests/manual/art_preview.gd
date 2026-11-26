extends Control
## Manual preview of the CNT-010 reference art (art-direction.md §9): a location plate at the
## in-game scale ×3 next to a dossier card with framed portraits, the other lighting variants of
## the same location at ×1 and the HS-16 swatches. Not part of the game and not run by GUT.
##
## Run from the editor (F6) or:
##   godot --path apps/desktop res://tests/manual/art_preview.tscn -- --plate=loc_treatment.dim
## `--capture=<file.png>` renders into a fixed 1920×1080 SubViewport, saves it and quits.
## Keys: ←/→ switch the plate.

const ART: String = "res://assets/art/"
const LOCATIONS: String = ART + "scenarios/sanatorium_winter/locations/"
const PORTRAITS: String = ART + "scenarios/sanatorium_winter/portraits/"
const FRAME: String = ART + "ui/frames/photo_frame.png"
const PALETTE: String = ART + "palette/hs16.gpl"
const SCREEN: Vector2i = Vector2i(1920, 1080)
const PLATE_SCALE: int = 3
const PORTRAIT_SCALE: int = 2
const FRAME_MARGIN: int = 6
const PLATES: Array[String] = [
	"loc_hall.bright", "loc_hall.dim",
	"loc_treatment.bright", "loc_treatment.dim", "loc_treatment.dark",
	"loc_lake_path.dim", "loc_lake_path.dark",
]
const NAMES: Dictionary = {
	"loc_hall": "Холл",
	"loc_treatment": "Процедурный корпус",
	"loc_lake_path": "Тропа к озеру",
}
const LIGHTING: Dictionary = {"bright": "Светло", "dim": "Полумрак", "dark": "Темно"}
# Dossier UI tokens, all from HS-16 (§6.3).
const DESK: Color = Color8(21, 26, 32)
const PAPER: Color = Color8(226, 204, 162)
const INK: Color = Color8(10, 12, 15)
const INK_SOFT: Color = Color8(51, 62, 71)
const STAMP: Color = Color8(111, 33, 29)
const MUTED: Color = Color8(147, 161, 159)

var _plate: String = "loc_treatment.dim"
var _capture: String = ""
var _canvas: Control = null


func _ready() -> void:
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--plate="):
			_plate = arg.trim_prefix("--plate=")
		elif arg.begins_with("--capture="):
			_capture = arg.trim_prefix("--capture=")
	if _capture.is_empty():
		_canvas = self
		_build()
		return
	var viewport: SubViewport = SubViewport.new()
	viewport.size = SCREEN
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	add_child(viewport)
	_canvas = Control.new()
	_canvas.size = Vector2(SCREEN)
	viewport.add_child(_canvas)
	_build()
	for i: int in 4:
		await RenderingServer.frame_post_draw
	var error: Error = viewport.get_texture().get_image().save_png(_capture)
	print("art_preview: saved %s (%s)" % [_capture, error_string(error)])
	get_tree().quit(0 if error == OK else 1)


func _unhandled_key_input(event: InputEvent) -> void:
	var key: InputEventKey = event as InputEventKey
	if key == null or not key.pressed or not _capture.is_empty():
		return
	var step: int = 1 if key.keycode == KEY_RIGHT else -1 if key.keycode == KEY_LEFT else 0
	if step != 0:
		_plate = PLATES[posmod(PLATES.find(_plate) + step, PLATES.size())]
		for child: Node in get_children():
			child.queue_free()
		_build()


func _build() -> void:
	# Pixel art is always drawn with nearest filtering at integer scale (§7.4).
	_canvas.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_rect(Vector2.ZERO, Vector2(SCREEN), DESK)

	var id: String = _plate.get_slice(".", 0)
	var level: String = _plate.get_slice(".", 1)
	_texture(LOCATIONS + _plate + ".png", Vector2(48, 48), PLATE_SCALE)
	_label("%s — %s · 384×216 ×%d" % [NAMES.get(id, id), LIGHTING.get(level, level), PLATE_SCALE],
		Vector2(48, 708), MUTED, 22)
	var x: float = 48.0
	for other: String in PLATES:
		if other.get_slice(".", 0) == id and other != _plate:
			_texture(LOCATIONS + other + ".png", Vector2(x, 752), 1)
			_label("%s ×1" % LIGHTING.get(other.get_slice(".", 1), ""), Vector2(x, 974), MUTED, 18)
			x += 384.0 + 24.0

	# Dossier card.
	var card: Vector2 = Vector2(1248, 48)
	_rect(card, Vector2(624, 984), PAPER)
	_label("ЛИЧНЫЕ ДЕЛА ПЕРСОНАЛА", card + Vector2(32, 24), INK, 26)
	_label("ЭТАЛОН · ПРЕДВАРИТЕЛЬНО", card + Vector2(32, 60), STAMP, 18)
	_portrait("head_doctor.m1", "Главный врач", card + Vector2(40, 112))
	_portrait("nurse.f1", "Медсестра", card + Vector2(352, 112))
	_label("Палитра HS-16", card + Vector2(32, 900), INK_SOFT, 18)
	var colors: Array[Color] = _palette()
	_rect(card + Vector2(28, 924), Vector2(colors.size() * 35 + 5, 40), INK)
	for i: int in colors.size():
		_rect(card + Vector2(32 + i * 35, 928), Vector2(32, 32), colors[i])


func _portrait(variant: String, title: String, at: Vector2) -> void:
	var holder: Control = Control.new()
	holder.position = at
	holder.scale = Vector2(PORTRAIT_SCALE, PORTRAIT_SCALE)
	_canvas.add_child(holder)
	var photo: TextureRect = TextureRect.new()
	photo.texture = load(PORTRAITS + variant + ".png") as Texture2D
	photo.position = Vector2(FRAME_MARGIN, FRAME_MARGIN)
	holder.add_child(photo)
	var frame: NinePatchRect = NinePatchRect.new()
	frame.texture = load(FRAME) as Texture2D
	frame.patch_margin_left = FRAME_MARGIN
	frame.patch_margin_top = FRAME_MARGIN
	frame.patch_margin_right = FRAME_MARGIN
	frame.patch_margin_bottom = FRAME_MARGIN
	frame.draw_center = false
	frame.size = Vector2(96 + FRAME_MARGIN * 2, 128 + FRAME_MARGIN * 2)
	holder.add_child(frame)
	var below: float = (128 + FRAME_MARGIN * 2) * PORTRAIT_SCALE + 12
	_label(title, at + Vector2(0, below), INK, 22)
	_label(variant + " · 96×128 ×%d" % PORTRAIT_SCALE, at + Vector2(0, below + 30), INK_SOFT, 16)


func _palette() -> Array[Color]:
	var colors: Array[Color] = []
	for line: String in FileAccess.get_file_as_string(PALETTE).split("\n"):
		var parts: PackedStringArray = line.strip_edges().replace("\t", " ").split(" ", false)
		if parts.size() >= 3 and parts[0].is_valid_int() and parts[1].is_valid_int() and parts[2].is_valid_int():
			colors.append(Color8(parts[0].to_int(), parts[1].to_int(), parts[2].to_int()))
	return colors


func _texture(path: String, at: Vector2, scale_factor: int) -> void:
	var rect: TextureRect = TextureRect.new()
	rect.texture = load(path) as Texture2D
	rect.position = at
	rect.scale = Vector2(scale_factor, scale_factor)
	_canvas.add_child(rect)


func _rect(at: Vector2, rect_size: Vector2, color: Color) -> void:
	var rect: ColorRect = ColorRect.new()
	rect.position = at
	rect.size = rect_size
	rect.color = color
	_canvas.add_child(rect)


func _label(text: String, at: Vector2, color: Color, font_size: int) -> void:
	var label: Label = Label.new()
	label.text = text
	label.position = at
	label.add_theme_color_override("font_color", color)
	label.add_theme_font_size_override("font_size", font_size)
	_canvas.add_child(label)
