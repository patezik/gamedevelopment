extends RefCounted
## The locations the player was shown while the Exploration screen is open: every location they
## stood in and every exit their views listed, with the links between them.
##
## PlayerView carries the player's known map in [code]knownMap[/code] (visited locations, shown
## exits and their links); it is merged as is. For a view without that field the model falls back
## to accumulating the current location and its exits. It never holds a place, link or name the
## server did not show the player. It lives as long as the screen and is cleared when the session
## ends.

## Separator of the two location ids in a link key; ids never contain a line break.
const LINK_SEPARATOR: String = "\n"

var _order: Array[String] = []
var _names: Dictionary = {}
var _visited: Dictionary = {}
var _links: Dictionary = {}
var _current: String = ""


func clear() -> void:
	_order.clear()
	_names.clear()
	_visited.clear()
	_links.clear()
	_current = ""


## Adds the location of [param view] (as visited and current), its exits and the links to them.
## A view without a location id changes nothing.
func observe(view: Dictionary) -> void:
	var raw_location: Variant = view.get("location")
	if not raw_location is Dictionary:
		return
	var location: Dictionary = raw_location
	var location_id: String = _text(location.get("id"))
	if location_id.is_empty():
		return
	_add(location_id, _text(location.get("name")))
	_visited[location_id] = true
	_current = location_id
	_merge_known_map(view.get("knownMap"))
	var raw_exits: Variant = location.get("exits")
	if not raw_exits is Array:
		return
	var exits: Array = raw_exits
	for raw_exit: Variant in exits:
		if not raw_exit is Dictionary:
			continue
		var exit: Dictionary = raw_exit
		var target: String = _text(exit.get("locationId"))
		if target.is_empty() or target == location_id:
			continue
		_add(target, _text(exit.get("name")))
		_links[_link_key(location_id, target)] = true


func _merge_known_map(raw_map: Variant) -> void:
	if not raw_map is Dictionary:
		return
	var known: Dictionary = raw_map
	var raw_locations: Variant = known.get("locations")
	if raw_locations is Array:
		var locations: Array = raw_locations
		for raw_entry: Variant in locations:
			if not raw_entry is Dictionary:
				continue
			var entry: Dictionary = raw_entry
			var entry_id: String = _text(entry.get("id"))
			if entry_id.is_empty():
				continue
			_add(entry_id, _text(entry.get("name")))
			if entry.get("visited") == true:
				_visited[entry_id] = true
	var raw_links: Variant = known.get("links")
	if raw_links is Array:
		var links_list: Array = raw_links
		for raw_link: Variant in links_list:
			if not raw_link is Dictionary:
				continue
			var link: Dictionary = raw_link
			var first: String = _text(link.get("from"))
			var second: String = _text(link.get("to"))
			if first.is_empty() or second.is_empty() or first == second:
				continue
			if _names.has(first) and _names.has(second):
				_links[_link_key(first, second)] = true


func is_empty() -> bool:
	return _order.is_empty()


## Location ids in the order they were first seen.
func location_ids() -> Array[String]:
	return _order.duplicate()


func has_location(location_id: String) -> bool:
	return _names.has(location_id)


## The last name the views gave [param location_id]; empty if unknown.
func location_name(location_id: String) -> String:
	return str(_names.get(location_id, ""))


## True if the player stood in [param location_id] (not only saw it as an exit).
func is_visited(location_id: String) -> bool:
	return _visited.has(location_id)


## The location of the latest observed view; empty before the first one.
func current() -> String:
	return _current


func has_link(first: String, second: String) -> bool:
	return _links.has(_link_key(first, second))


## Links as [first, second] pairs of ids (first < second), sorted.
func links() -> Array[PackedStringArray]:
	var keys: Array[String] = []
	for key: Variant in _links:
		keys.append(str(key))
	keys.sort()
	var result: Array[PackedStringArray] = []
	for key: String in keys:
		result.append(key.split(LINK_SEPARATOR))
	return result


## Grid cell of every location: column = number of known links from the current location,
## row = order of discovery within the column. Locations not reachable over known links get the
## column after the farthest one.
func layout() -> Dictionary:
	var distance: Dictionary = {}
	if not _current.is_empty():
		distance[_current] = 0
		var queue: Array[String] = [_current]
		while not queue.is_empty():
			var from: String = queue.pop_front()
			var from_distance: int = distance[from]
			var next_distance: int = from_distance + 1
			for neighbour: String in _neighbours(from):
				if not distance.has(neighbour):
					distance[neighbour] = next_distance
					queue.append(neighbour)
	var farthest: int = -1
	for value: Variant in distance.values():
		var known: int = value
		farthest = maxi(farthest, known)
	var rows: Dictionary = {}
	var cells: Dictionary = {}
	for location_id: String in _order:
		var column: int = distance.get(location_id, farthest + 1)
		var row: int = rows.get(column, 0)
		rows[column] = row + 1
		cells[location_id] = Vector2i(column, row)
	return cells


func _neighbours(location_id: String) -> Array[String]:
	var result: Array[String] = []
	for other: String in _order:
		if other != location_id and has_link(location_id, other):
			result.append(other)
	return result


func _add(location_id: String, display_name: String) -> void:
	if not _names.has(location_id):
		_order.append(location_id)
		_names[location_id] = display_name
	elif not display_name.is_empty():
		_names[location_id] = display_name


static func _link_key(first: String, second: String) -> String:
	if first < second:
		return first + LINK_SEPARATOR + second
	return second + LINK_SEPARATOR + first


static func _text(value: Variant) -> String:
	if value is String:
		var text: String = value
		return text
	return ""
