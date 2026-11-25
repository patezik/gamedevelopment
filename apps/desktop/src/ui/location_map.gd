extends Control
## Schematic map of a [code]known_map.gd[/code] model: one box per known location on the model's
## grid layout, lines for the known links. The current location is highlighted; locations seen
## only as exits are dimmed. Draws nothing it was not given: no world graph, no hidden places.

const KnownMap = preload("res://src/ui/known_map.gd")

const CELL_SIZE: Vector2 = Vector2(200.0, 44.0)
const CELL_GAP: Vector2 = Vector2(56.0, 14.0)
const LINK_WIDTH: float = 2.0
const LINK_COLOR: Color = Color(0.62, 0.66, 0.7, 0.8)
const CURRENT_COLOR: Color = Color(0.82, 0.62, 0.24, 1.0)
const VISITED_COLOR: Color = Color(0.2, 0.24, 0.28, 1.0)
const SEEN_COLOR: Color = Color(0.14, 0.16, 0.18, 1.0)
const SEEN_ALPHA: float = 0.6
## Metadata of each location box.
const META_LOCATION_ID: StringName = &"location_id"
const META_CURRENT: StringName = &"current"
const META_VISITED: StringName = &"visited"

var _centers: Dictionary = {}
var _links: Array[PackedStringArray] = []


## Replaces the drawing with [param map].
func show_map(map: KnownMap) -> void:
	for child: Node in get_children():
		remove_child(child)
		child.queue_free()
	_centers.clear()
	_links = map.links()
	var cells: Dictionary = map.layout()
	var extent: Vector2 = Vector2.ZERO
	for location_id: String in map.location_ids():
		var cell: Vector2i = cells[location_id]
		var origin: Vector2 = Vector2(cell) * (CELL_SIZE + CELL_GAP)
		var box: Label = _make_box(map, location_id)
		box.position = origin
		box.size = CELL_SIZE
		add_child(box)
		_centers[location_id] = origin + CELL_SIZE * 0.5
		extent = extent.max(origin + CELL_SIZE)
	custom_minimum_size = extent
	queue_redraw()


## The location boxes, in the order they were drawn.
func location_boxes() -> Array[Label]:
	var boxes: Array[Label] = []
	for child: Node in get_children():
		if child is Label and child.has_meta(META_LOCATION_ID):
			boxes.append(child as Label)
	return boxes


func _draw() -> void:
	for link: PackedStringArray in _links:
		if link.size() != 2 or not _centers.has(link[0]) or not _centers.has(link[1]):
			continue
		var start: Vector2 = _centers[link[0]]
		var end: Vector2 = _centers[link[1]]
		draw_line(start, end, LINK_COLOR, LINK_WIDTH, true)


func _make_box(map: KnownMap, location_id: String) -> Label:
	var current: bool = location_id == map.current()
	var visited: bool = map.is_visited(location_id)
	var box: Label = Label.new()
	box.name = "Location%d" % get_child_count()
	box.text = map.location_name(location_id)
	if box.text.is_empty():
		box.text = "?"
	box.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	box.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	box.clip_text = true
	box.mouse_filter = Control.MOUSE_FILTER_PASS
	var style: StyleBoxFlat = StyleBoxFlat.new()
	style.bg_color = CURRENT_COLOR if current else (VISITED_COLOR if visited else SEEN_COLOR)
	style.set_corner_radius_all(4)
	style.set_content_margin_all(6.0)
	box.add_theme_stylebox_override(&"normal", style)
	if current:
		box.add_theme_color_override(&"font_color", Color.BLACK)
		box.tooltip_text = "Вы здесь"
	elif not visited:
		box.modulate.a = SEEN_ALPHA
		box.tooltip_text = "Ещё не посещали"
	box.set_meta(META_LOCATION_ID, location_id)
	box.set_meta(META_CURRENT, current)
	box.set_meta(META_VISITED, visited)
	return box
