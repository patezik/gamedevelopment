extends RefCounted
## Deep read-only copies of plain data (Dictionary, Array, scalars) handed from the autoloads to
## screens: a screen can read a PlayerView or route params but cannot change the shared copy.


## A deep copy of [param value] in which every Dictionary and Array is read-only.
## Objects are not copied; callers that need plain data check [method has_object] first.
static func freeze(value: Variant) -> Variant:
	if value is Dictionary:
		var source: Dictionary = value
		var copy: Dictionary = {}
		for key: Variant in source:
			copy[key] = freeze(source[key])
		copy.make_read_only()
		return copy
	if value is Array:
		var items: Array = value
		var copy_items: Array = []
		for item: Variant in items:
			copy_items.append(freeze(item))
		copy_items.make_read_only()
		return copy_items
	return value


## An empty read-only Dictionary.
static func empty() -> Dictionary:
	var result: Dictionary = {}
	result.make_read_only()
	return result


## True if [param value] is an Object or contains one at any depth (as a key or a value).
static func has_object(value: Variant) -> bool:
	if value is Object:
		return true
	if value is Dictionary:
		var source: Dictionary = value
		for key: Variant in source:
			if has_object(key) or has_object(source[key]):
				return true
	elif value is Array:
		var items: Array = value
		for item: Variant in items:
			if has_object(item):
				return true
	return false
