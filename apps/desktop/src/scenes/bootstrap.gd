extends Label


func _ready() -> void:
	var version: String = str(ProjectSettings.get_setting("application/config/version"))
	text = "Hollow Signal · %s" % version
