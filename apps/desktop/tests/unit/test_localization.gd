extends GutTest

const LocalizationScript = preload("res://src/autoload/localization.gd")
const CSV_PATH: String = "user://test_localization_qa003.csv"

var _loc: LocalizationScript
var _saved_locale: String


func before_each() -> void:
	_saved_locale = TranslationServer.get_locale()
	_remove_translations()
	_write("key,ru,en\nhello,Привет,Hello\nonly_ru,Только ру,\nquoted,\"а, б\",\"a, b\"\n")
	_loc = LocalizationScript.new()
	_loc.csv_path = CSV_PATH
	add_child_autofree(_loc)


func after_each() -> void:
	TranslationServer.set_locale(_saved_locale)
	_remove_translations()
	Localization.load_table()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(CSV_PATH))


func _remove_translations() -> void:
	for locale: String in ["ru", "en"]:
		var tr_obj: Translation = TranslationServer.get_translation_object(locale)
		if tr_obj != null:
			TranslationServer.remove_translation(tr_obj)


func _write(content: String) -> void:
	var file: FileAccess = FileAccess.open(CSV_PATH, FileAccess.WRITE)
	file.store_string(content)
	file.close()


func test_locale_columns_are_registered() -> void:
	assert_eq(_loc.locales(), PackedStringArray(["ru", "en"]))


func test_text_follows_the_current_locale() -> void:
	TranslationServer.set_locale("en")
	assert_eq(_loc.text("hello"), "Hello")
	TranslationServer.set_locale("ru")
	assert_eq(_loc.text("hello"), "Привет")


func test_csv_quoting_is_respected() -> void:
	assert_eq(_loc.text("quoted", "en"), "a, b")


func test_missing_key_falls_back_to_ru() -> void:
	assert_eq(_loc.text("only_ru", "en"), "Только ру")


func test_key_missing_everywhere_is_returned_as_is() -> void:
	assert_eq(_loc.text("nope", "en"), "nope")


func test_missing_keys_lists_untranslated() -> void:
	assert_eq(_loc.missing_keys("en"), PackedStringArray(["only_ru"]))


func test_shipped_table_is_complete() -> void:
	_remove_translations()
	assert_eq(Localization.load_table(), OK)
	assert_true(Localization.locales().has("ru"))
	assert_true(Localization.locales().has("en"))
	for locale: String in Localization.locales():
		assert_eq(Localization.missing_keys(locale), PackedStringArray(), "locale %s is complete" % locale)
