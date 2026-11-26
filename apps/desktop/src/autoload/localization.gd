extends Node
## Localization: UI strings by key from a CSV table (QA-003).
##
## `res://assets/i18n/strings.csv` has the header `key,ru,en,...`: the first column is the key, every
## other column is a locale. The tables are registered as Translation objects in the
## TranslationServer, and [method text] looks a key up for the current locale. A key missing from the
## current locale falls back to Russian (the source language) with a warning; a key missing from ru
## too is returned as is. A new language is a new column, no code changes.

const DEFAULT_PATH: String = "res://assets/i18n/strings.csv"
const SOURCE_LOCALE: String = "ru"

## Where the table lives; tests point it at a scratch file before [method load_table].
var csv_path: String = DEFAULT_PATH

var _locales: PackedStringArray = PackedStringArray()
var _warned: Dictionary = {}


func _ready() -> void:
	load_table()


## Reads [member csv_path] and registers one Translation per locale column.
func load_table() -> Error:
	var file: FileAccess = FileAccess.open(csv_path, FileAccess.READ)
	if file == null:
		var error: Error = FileAccess.get_open_error()
		push_warning("Localization: %s could not be read (%s)" % [csv_path, error_string(error)])
		return error
	for locale: String in _locales:
		var old: Translation = TranslationServer.get_translation_object(locale)
		if old != null:
			TranslationServer.remove_translation(old)
	_locales = PackedStringArray()
	_warned.clear()
	var header: PackedStringArray = file.get_csv_line()
	var translations: Array[Translation] = []
	for column: int in range(1, header.size()):
		var translation: Translation = Translation.new()
		translation.locale = header[column]
		translations.append(translation)
		_locales.append(header[column])
	while not file.eof_reached():
		var row: PackedStringArray = file.get_csv_line()
		if row.size() < 2 or row[0].is_empty():
			continue
		for column: int in range(1, mini(row.size(), header.size())):
			if not row[column].is_empty():
				translations[column - 1].add_message(row[0], row[column])
	for translation: Translation in translations:
		TranslationServer.add_translation(translation)
	return OK


func locales() -> PackedStringArray:
	return _locales


## The text of [param key] for [param locale] (the current one by default), with the ru fallback.
func text(key: String, locale: String = "") -> String:
	var target: String = locale if not locale.is_empty() else TranslationServer.get_locale()
	var found: String = _message(key, target)
	if not found.is_empty():
		return found
	var fallback: String = _message(key, SOURCE_LOCALE)
	var mark: String = "%s:%s" % [target, key]
	if not _warned.has(mark):
		_warned[mark] = true
		push_warning("Localization: key '%s' is missing for '%s', falling back to '%s'" % [
			key, target, SOURCE_LOCALE
		])
	return fallback if not fallback.is_empty() else key


## Keys that ru has but [param locale] lacks.
func missing_keys(locale: String) -> PackedStringArray:
	var missing: PackedStringArray = PackedStringArray()
	var source: Translation = TranslationServer.get_translation_object(SOURCE_LOCALE)
	if source == null:
		return missing
	var target: Translation = TranslationServer.get_translation_object(locale)
	for key: StringName in source.get_message_list():
		if target == null or target.get_message(key) == "":
			missing.append(String(key))
	return missing


func _message(key: String, locale: String) -> String:
	var translation: Translation = TranslationServer.get_translation_object(locale)
	if translation == null:
		return ""
	return String(translation.get_message(key))
