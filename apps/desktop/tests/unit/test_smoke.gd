extends GutTest


func test_project_has_expected_name() -> void:
	var project_name: String = str(ProjectSettings.get_setting("application/config/name"))
	assert_eq(project_name, "Hollow Signal")
