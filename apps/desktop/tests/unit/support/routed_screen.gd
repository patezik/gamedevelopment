extends Node
## Screen stub for SceneRouter tests: keeps the params it received and what it saw in _ready.

var params: Dictionary = {}
var params_at_ready: Dictionary = {}


func set_params(route_params: Dictionary) -> void:
	params = route_params


func _ready() -> void:
	params_at_ready = params
