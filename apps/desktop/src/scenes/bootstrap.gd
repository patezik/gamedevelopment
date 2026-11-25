extends Label

const EndingWatcher = preload("res://src/scenes/ending/ending_watcher.gd")


func _ready() -> void:
	var version: String = str(ProjectSettings.get_setting("application/config/version"))
	text = "Hollow Signal · %s" % version
	# Developer panel on F12 (GDT-011); adds nothing in a release build.
	DebugOverlay.install(get_tree().root)
	# Sanity and Static screen effects (GDT-010); they outlive SceneRouter screen changes.
	HorrorFx.install(get_tree().root)
	# Opens the Ending screen once the server reports the game over (GDT-009).
	EndingWatcher.install(get_tree().root)
