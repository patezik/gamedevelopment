extends Node
## SceneRouter stand-in for screen tests: records goto calls and changes no screen.

var routes: Array[Dictionary] = []
var result: Error = OK


func goto(screen: StringName, params: Dictionary = {}) -> Error:
	routes.append({"screen": screen, "params": params})
	return result


func last_screen() -> StringName:
	return routes.back()["screen"] if not routes.is_empty() else &""
