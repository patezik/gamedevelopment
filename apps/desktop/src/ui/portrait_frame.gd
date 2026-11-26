extends Control
## A character portrait as a dossier photo (art-direction.md §6): the 96×128 picture inside the
## 9-slice `photo_frame.png`, both at an integer scale with nearest filtering. Without a picture
## (empty `portraitRef`, a missing file or one still loading) it shows the same neutral
## silhouette for everyone, so the placeholder tells nothing about the character.

const ArtLibrary = preload("res://src/ui/art_library.gd")

## HS-16 colours of the silhouette (art-direction.md §3): the portrait wall C4→C3, figure C1.
const WALL_TOP: Color = Color8(74, 88, 96)
const WALL_BOTTOM: Color = Color8(51, 62, 71)
const FIGURE: Color = Color8(21, 26, 32)

static var _silhouette: Texture2D = null

var _scale: int = ArtLibrary.PORTRAIT_SCALE
var _holder: Control = null
var _photo: TextureRect = null
var _frame: NinePatchRect = null
var _has_portrait: bool = false


func _init() -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_holder = Control.new()
	_holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_holder)
	_photo = TextureRect.new()
	_photo.name = "Photo"
	_photo.position = Vector2(ArtLibrary.FRAME_MARGIN, ArtLibrary.FRAME_MARGIN)
	_photo.size = Vector2(ArtLibrary.PORTRAIT_SIZE)
	_photo.stretch_mode = TextureRect.STRETCH_KEEP
	_photo.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_holder.add_child(_photo)
	_frame = NinePatchRect.new()
	_frame.name = "Frame"
	_frame.texture = load(ArtLibrary.FRAME_PATH) as Texture2D
	_frame.patch_margin_left = ArtLibrary.FRAME_MARGIN
	_frame.patch_margin_top = ArtLibrary.FRAME_MARGIN
	_frame.patch_margin_right = ArtLibrary.FRAME_MARGIN
	_frame.patch_margin_bottom = ArtLibrary.FRAME_MARGIN
	_frame.draw_center = false
	_frame.size = Vector2(ArtLibrary.PORTRAIT_SIZE + Vector2i.ONE * ArtLibrary.FRAME_MARGIN * 2)
	_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_holder.add_child(_frame)
	set_display_scale(_scale)
	show_portrait(null)


## Integer display scale: ×2 for cards (default), ×3 for the dialogue.
func set_display_scale(factor: int) -> void:
	_scale = maxi(1, factor)
	_holder.scale = Vector2(_scale, _scale)
	custom_minimum_size = _frame.size * _scale


func get_display_scale() -> int:
	return _scale


## Shows [param texture] in the frame, or the silhouette when it is `null`.
func show_portrait(texture: Texture2D) -> void:
	_has_portrait = texture != null
	_photo.texture = texture if _has_portrait else silhouette()


func has_portrait() -> bool:
	return _has_portrait


func get_photo() -> TextureRect:
	return _photo


func get_frame() -> NinePatchRect:
	return _frame


## The shared placeholder: a head-and-shoulders shape on the portrait wall, 96×128.
static func silhouette() -> Texture2D:
	if _silhouette != null:
		return _silhouette
	var size: Vector2i = ArtLibrary.PORTRAIT_SIZE
	var image: Image = Image.create_empty(size.x, size.y, false, Image.FORMAT_RGBA8)
	for y: int in size.y:
		var wall: Color = WALL_TOP if y * 2 < size.y else WALL_BOTTOM
		for x: int in size.x:
			image.set_pixel(x, y, FIGURE if _in_figure(x, y, size) else wall)
	_silhouette = ImageTexture.create_from_image(image)
	return _silhouette


static func _in_figure(x: int, y: int, size: Vector2i) -> bool:
	var center: float = size.x / 2.0
	# Head: an ellipse with the eye line near 35 % of the height (§6.2).
	var head: Vector2 = Vector2((x + 0.5 - center) / 19.0, (y + 0.5 - 50.0) / 24.0)
	if head.length_squared() <= 1.0:
		return true
	# Neck.
	if absf(x + 0.5 - center) <= 8.0 and y >= 70 and y < 88:
		return true
	# Shoulders leave the frame at the sides and the bottom.
	var shoulders: Vector2 = Vector2((x + 0.5 - center) / 52.0, (y + 0.5 - 132.0) / 46.0)
	return shoulders.length_squared() <= 1.0
