extends GutTest

const AudioDirectorScript = preload("res://src/autoload/audio_director.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const GameStoreScript = preload("res://src/autoload/game_store.gd")
const FakeBackend = preload("res://tests/unit/support/fake_backend.gd")

var _backend: FakeBackend
var _store: GameStoreScript
var _audio: AudioDirectorScript
var _version: int = 0


func before_each() -> void:
	_backend = FakeBackend.new()
	add_child_autofree(_backend)
	_store = GameStoreScript.new()
	add_child_autofree(_store)
	_store.bind_backend(_backend)
	_audio = AudioDirectorScript.new()
	add_child_autofree(_audio)
	_audio.bind_store(_store)
	_version = 0


func _view(location_id: String, period: String, sanity: int, level: int) -> Dictionary:
	return {
		"clock": {"day": 1, "time": "22:00", "period": period},
		"location": {"id": location_id, "name": "—", "lighting": "dark"},
		"vitals": {"health": 10, "sanity": sanity, "fatigue": 0},
		"static": level,
	}


func _push(view: Dictionary) -> void:
	_version += 1
	assert_true(_store.set_view(view, _version))


func _event(kind: String, extra: Dictionary = {}) -> void:
	var event: Dictionary = {"type": kind}
	event.merge(extra)
	_backend.deliver(ProtocolConstants.MSG_EVENT, {"event": event})


func test_ambient_key_reads_place_light_and_period() -> void:
	assert_eq(AudioDirectorScript.ambient_key_for({}), "")
	assert_eq(AudioDirectorScript.ambient_key_for(_view("loc_cellar", "night", 9, 0)), "loc_cellar|dark|night")
	assert_eq(AudioDirectorScript.ambient_key_for({"clock": {"period": "day"}}), "||day")
	assert_eq(AudioDirectorScript.ambient_key_for({"location": "broken", "clock": 5}), "")


func test_ambient_starts_with_a_view_and_follows_the_place_and_period() -> void:
	assert_eq(_audio.get_ambient_key(), "", "silent before the first view")
	watch_signals(_audio)
	_push(_view("loc_hall", "evening", 9, 0))
	assert_eq(_audio.get_ambient_key(), "loc_hall|dark|evening")
	assert_true(_audio.is_ambient_playing())
	var playing: Array[AudioStreamPlayer] = []
	for child: Node in _audio.get_children():
		if child is AudioStreamPlayer and (child as AudioStreamPlayer).playing:
			playing.append(child as AudioStreamPlayer)
	assert_eq(playing.size(), 1)
	assert_eq(playing[0].stream, _audio.ambient_stream("loc_hall|dark|evening"))
	assert_almost_eq(playing[0].pitch_scale, AudioDirectorScript.ambient_pitch("loc_hall|dark|evening"), 0.0001)
	_push(_view("loc_hall", "evening", 9, 1))
	assert_signal_emit_count(_audio, "ambient_changed", 1, "same place and period: no change")
	_push(_view("loc_hall", "night", 9, 2))
	_push(_view("loc_cellar", "night", 9, 3))
	assert_signal_emit_count(_audio, "ambient_changed", 3)
	assert_eq(_audio.get_ambient_key(), "loc_cellar|dark|night")


func test_quick_changes_leave_no_loop_behind() -> void:
	_push(_view("loc_hall", "day", 9, 0))
	_push(_view("loc_cellar", "day", 9, 0))
	_backend.change_state(BackendScript.ConnectionState.CONNECTING)
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	await wait_seconds(AudioDirectorScript.AMBIENT_FADE_SECONDS + 0.3)
	for child: Node in _audio.get_children():
		if child is AudioStreamPlayer:
			assert_false((child as AudioStreamPlayer).playing, "%s stopped" % child.name)


func test_session_end_silences_the_ambient() -> void:
	_push(_view("loc_hall", "day", 9, 0))
	_backend.change_state(BackendScript.ConnectionState.CONNECTING)
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	assert_eq(_audio.get_ambient_key(), "")
	assert_false(_audio.is_ambient_playing())


func test_stinger_rules_compare_consecutive_views() -> void:
	var drop: StringName = AudioDirectorScript.stinger_for_change(6, 4, 10, 10)
	assert_eq(drop, AudioDirectorScript.STINGER_SANITY_DROP)
	assert_eq(AudioDirectorScript.stinger_for_change(6, 6, 24, 25), AudioDirectorScript.STINGER_STATIC_THRESHOLD)
	assert_eq(AudioDirectorScript.stinger_for_change(6, 7, 49, 76), AudioDirectorScript.STINGER_STATIC_THRESHOLD)
	assert_eq(AudioDirectorScript.stinger_for_change(6, 7, 25, 49), &"", "no threshold crossed")
	assert_eq(AudioDirectorScript.stinger_for_change(6, 7, 60, 20), &"", "Static falling is quiet")
	assert_eq(AudioDirectorScript.stinger_for_change(null, 2, null, 90), &"", "nothing to compare with")
	assert_eq(AudioDirectorScript.stinger_for_change(6, 9, 30, 30), &"", "sanity rising is quiet")


func test_view_changes_play_stingers_but_not_on_the_first_view() -> void:
	watch_signals(_audio)
	_push(_view("loc_hall", "night", 6, 20))
	assert_signal_not_emitted(_audio, "stinger_played", "the first view sets the baseline")
	_push(_view("loc_hall", "night", 4, 20))
	assert_signal_emitted_with_parameters(_audio, "stinger_played", [AudioDirectorScript.STINGER_SANITY_DROP])


func test_stingers_are_rare_except_game_over() -> void:
	watch_signals(_audio)
	assert_true(_audio.play_stinger(AudioDirectorScript.STINGER_STATIC_THRESHOLD))
	assert_false(_audio.play_stinger(AudioDirectorScript.STINGER_SANITY_DROP), "too soon")
	assert_true(_audio.play_stinger(AudioDirectorScript.STINGER_GAME_OVER))
	assert_signal_emit_count(_audio, "stinger_played", 2)


func test_events_play_their_stingers() -> void:
	watch_signals(_audio)
	_event(ProtocolConstants.EVENT_INCOMING_CALL, {"callId": "call_1"})
	assert_signal_emitted_with_parameters(_audio, "stinger_played", [AudioDirectorScript.STINGER_INCOMING_CALL])
	_event(ProtocolConstants.EVENT_NOTIFICATION, {"notificationId": "n_1"})
	_event(ProtocolConstants.EVENT_GAME_OVER)
	assert_signal_emit_count(_audio, "stinger_played", 2, "a notification is not a stinger")
	assert_signal_emitted_with_parameters(_audio, "stinger_played", [AudioDirectorScript.STINGER_GAME_OVER])


func test_unknown_stinger_is_refused() -> void:
	assert_false(_audio.play_stinger(&"scream"))
	assert_push_warning("unknown stinger")


func test_a_new_session_forgets_the_previous_values() -> void:
	watch_signals(_audio)
	_push(_view("loc_hall", "night", 8, 20))
	_backend.change_state(BackendScript.ConnectionState.CONNECTING)
	_backend.change_state(BackendScript.ConnectionState.OFFLINE)
	_version = 0
	_push(_view("loc_hall", "night", 2, 90))
	assert_signal_not_emitted(_audio, "stinger_played")


func test_a_view_with_server_truth_is_ignored() -> void:
	var view: Dictionary = _view("loc_hall", "night", 1, 99)
	view["hallucination"] = true
	_audio.show_view(view)
	assert_eq(_audio.get_ambient_key(), "")


func test_placeholder_sounds_are_deterministic_and_loop() -> void:
	var key: String = "loc_hall|dim|night"
	var first: AudioStreamWAV = _audio.ambient_stream(key)
	assert_eq(first.loop_mode, AudioStreamWAV.LOOP_FORWARD)
	assert_eq(first.loop_end, AudioDirectorScript.AMBIENT_MIX_RATE * AudioDirectorScript.AMBIENT_LOOP_SECONDS)
	var other: AudioDirectorScript = AudioDirectorScript.new()
	add_child_autofree(other)
	assert_eq(other.ambient_stream(key).data, first.data, "same key, same sound")
	assert_ne(other.ambient_stream("loc_cellar|dark|night").data, first.data)
	assert_true(
		AudioDirectorScript.ambient_pitch("loc_hall|dim|night")
		< AudioDirectorScript.ambient_pitch("loc_hall|dim|day"),
		"night sits lower than day"
	)
	assert_eq(AudioDirectorScript.ambient_pitch("loc_hall|dim|night"), AudioDirectorScript.ambient_pitch(key))
	assert_eq(AudioDirectorScript.ambient_pitch(""), AudioDirectorScript.ambient_pitch("||"), "no data: neutral")
	for kind: StringName in AudioDirectorScript.STINGERS:
		var stinger: AudioStreamWAV = _audio.stinger_stream(kind)
		assert_eq(stinger.loop_mode, AudioStreamWAV.LOOP_DISABLED, String(kind))
		assert_true(stinger.get_length() > 0.5, String(kind))


func test_the_autoload_follows_the_game_store() -> void:
	var autoload: Node = get_tree().root.get_node_or_null(^"AudioDirector")
	assert_true(autoload is AudioDirectorScript)


func test_a_store_bound_before_ready_starts_the_ambience_on_ready() -> void:
	var early: AudioDirectorScript = AudioDirectorScript.new()
	_push(_view("loc_hall", "day", 9, 0))
	early.bind_store(_store)
	assert_false(early.play_stinger(AudioDirectorScript.STINGER_GAME_OVER), "no players yet")
	add_child_autofree(early)
	assert_eq(early.get_ambient_key(), "loc_hall|dark|day")
	assert_true(early.is_ambient_playing())
