extends Label


func _ready() -> void:
	var version: String = str(ProjectSettings.get_setting("application/config/version"))
	text = "Hollow Signal · %s" % version
	# Developer panel on F12 (GDT-011); adds nothing in a release build.
	DebugOverlay.install(get_tree().root)
