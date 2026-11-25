extends Node
## AudioDirector: ambient sound for the current place and time of day, and stingers on events.
##
## It follows the `GameStore` autoload, not the screens, so the ambience carries over SceneRouter
## screen changes. Everything it reacts to is already in the PlayerView or in a ClientEvent
## (ADR 0002): `location.id`, `location.lighting`, `clock.period`, `vitals.sanity`, `static`, and
## the `incomingCall` / `gameOver` events. It computes no game rule and keeps only the last values
## it heard.
##
## The sounds are placeholders synthesised in code: a drone with dark noise per lighting, pitched
## by the period and the place, and short stingers. They are original, licence-free and
## deterministic, and are all built once in [method _ready] (before the first frame), so nothing
## is synthesised during play. Final assets replace them in CNT-011 through
## [method ambient_stream], [method ambient_pitch] and [method stinger_stream].

const GameStoreScript = preload("res://src/autoload/game_store.gd")
const BackendScript = preload("res://src/autoload/backend.gd")
const HorrorFxScript = preload("res://src/scenes/overlays/horror_fx/horror_fx.gd")

## The ambience changed; [param key] is "" when it fell silent.
signal ambient_changed(key: String)
## A stinger started.
signal stinger_played(kind: StringName)

## Sanity went down between two consecutive views (a grim find, a dark place at night...).
const STINGER_SANITY_DROP: StringName = &"sanity_drop"
## Static rose past one of [constant STATIC_THRESHOLDS].
const STINGER_STATIC_THRESHOLD: StringName = &"static_threshold"
## An `incomingCall` event.
const STINGER_INCOMING_CALL: StringName = &"incoming_call"
## A `gameOver` event.
const STINGER_GAME_OVER: StringName = &"game_over"
const STINGERS: Array[StringName] = [
	STINGER_SANITY_DROP, STINGER_STATIC_THRESHOLD, STINGER_INCOMING_CALL, STINGER_GAME_OVER
]
## Static thresholds of survival-horror.md §3; the stinger marks crossing one upwards.
const STATIC_THRESHOLDS: Array[int] = [25, 50, 75]
## Stingers are rare (game-design.md §8): another one waits at least this long, in real time.
## The game-over stinger always plays.
const STINGER_MIN_GAP_MS: int = 2000

const AMBIENT_VOLUME_DB: float = -16.0
const STINGER_VOLUME_DB: float = -9.0
const SILENT_DB: float = -60.0
const AMBIENT_FADE_SECONDS: float = 2.0

## Placeholder synthesis parameters.
const AMBIENT_MIX_RATE: int = 8000
const AMBIENT_LOOP_SECONDS: int = 4
const STINGER_MIX_RATE: int = 16000
## Drone frequency of the base loops, in Hz; the period and the place pitch it.
const AMBIENT_FREQUENCY: float = 65.0
## Pitch of the ambience per `clock.period`; darker hours sit lower.
const PERIOD_PITCH: Dictionary = {
	"morning": 1.12,
	"day": 1.26,
	"evening": 0.95,
	"night": 0.75,
}
## Level of the dark noise layer per `location.lighting`.
const LIGHTING_NOISE: Dictionary = {
	"bright": 0.05,
	"dim": 0.1,
	"dark": 0.18,
}
const DEFAULT_NOISE: float = 0.1

var _store: GameStoreScript
var _ambient_players: Array[AudioStreamPlayer] = []
var _active_player: int = 0
var _stinger_player: AudioStreamPlayer
var _fade: Tween
var _ambient_key: String = ""
var _last_sanity: Variant = null
var _last_static: Variant = null
var _last_stinger_ms: int = -STINGER_MIN_GAP_MS
## Placeholder sounds: lighting (or "") -> ambience loop, stinger kind -> one-shot.
var _bank: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for lighting: String in LIGHTING_NOISE.keys() + [""]:
		_bank[lighting] = _synth_ambient(lighting)
	for kind: StringName in STINGERS:
		_bank[kind] = _synth_stinger(kind)
	for index: int in 2:
		var player: AudioStreamPlayer = AudioStreamPlayer.new()
		player.name = "Ambient%d" % index
		player.volume_db = SILENT_DB
		add_child(player)
		_ambient_players.append(player)
	_stinger_player = AudioStreamPlayer.new()
	_stinger_player.name = "Stinger"
	_stinger_player.volume_db = STINGER_VOLUME_DB
	add_child(_stinger_player)
	if not _ambient_key.is_empty():
		_crossfade()
	if _store == null:
		var autoload: Node = get_node_or_null(^"/root/GameStore")
		if autoload is GameStoreScript:
			bind_store(autoload as GameStoreScript)


## Follows [param store] instead of the current one and picks the ambience of its current view.
## The autoload binds the `GameStore` autoload itself; tests pass their own store.
func bind_store(store: GameStoreScript) -> void:
	if _store != null and is_instance_valid(_store):
		if _store.view_changed.is_connected(_on_view_changed):
			_store.view_changed.disconnect(_on_view_changed)
		if _store.event_received.is_connected(_on_event_received):
			_store.event_received.disconnect(_on_event_received)
		if _store.connection_state_changed.is_connected(_on_connection_state_changed):
			_store.connection_state_changed.disconnect(_on_connection_state_changed)
	_store = store
	_forget_session()
	var view: Dictionary = {}
	if _store != null:
		_store.view_changed.connect(_on_view_changed)
		_store.event_received.connect(_on_event_received)
		_store.connection_state_changed.connect(_on_connection_state_changed)
		if _store.has_view():
			view = _store.get_view()
	show_view(view)


## Takes [param view] as the latest state: switches the ambience if the place, light or period
## changed and plays a stinger if sanity fell or Static crossed a threshold since the previous
## view. A view with a server-only key is treated as no view.
func show_view(view: Dictionary) -> void:
	if not GameStoreScript.find_forbidden_key(view).is_empty():
		view = {}
	_set_ambient(ambient_key_for(view))
	var sanity: Variant = HorrorFxScript.sanity_of(view)
	var level: Variant = HorrorFxScript.static_of(view)
	var stinger: StringName = stinger_for_change(_last_sanity, sanity, _last_static, level)
	_last_sanity = sanity
	_last_static = level
	if not stinger.is_empty():
		play_stinger(stinger)


## The ambience key of [param view]: "<location.id>|<lighting>|<period>", or "" (silence) when
## the view has neither a location nor a period.
static func ambient_key_for(view: Dictionary) -> String:
	var location_id: String = ""
	var lighting: String = ""
	var location: Variant = view.get("location")
	if location is Dictionary:
		location_id = _text((location as Dictionary).get("id"))
		lighting = _text((location as Dictionary).get("lighting"))
	var period: String = ""
	var clock: Variant = view.get("clock")
	if clock is Dictionary:
		period = _text((clock as Dictionary).get("period"))
	if location_id.is_empty() and period.is_empty():
		return ""
	return "%s|%s|%s" % [location_id, lighting, period]


## The stinger for a change from the previous view to the next one, or &"" for none. Without a
## previous value (first view, new session) nothing plays. A sanity drop wins over Static.
static func stinger_for_change(
	sanity_before: Variant, sanity_after: Variant, static_before: Variant, static_after: Variant
) -> StringName:
	if sanity_before is int and sanity_after is int and (sanity_after as int) < (sanity_before as int):
		return STINGER_SANITY_DROP
	if static_before is int and static_after is int:
		for threshold: int in STATIC_THRESHOLDS:
			if (static_before as int) < threshold and (static_after as int) >= threshold:
				return STINGER_STATIC_THRESHOLD
	return &""


## Plays the stinger [param kind] unless another one played less than
## [constant STINGER_MIN_GAP_MS] ago (the game-over stinger always plays). Returns true if it
## started.
func play_stinger(kind: StringName) -> bool:
	if not STINGERS.has(kind):
		push_warning("AudioDirector: unknown stinger '%s'" % kind)
		return false
	if not is_node_ready():
		return false
	var now: int = Time.get_ticks_msec()
	if kind != STINGER_GAME_OVER and now - _last_stinger_ms < STINGER_MIN_GAP_MS:
		return false
	_last_stinger_ms = now
	_stinger_player.stream = stinger_stream(kind)
	_stinger_player.play()
	stinger_played.emit(kind)
	return true


## The current ambience key; "" while silent.
func get_ambient_key() -> String:
	return _ambient_key


## True while an ambience loop plays (it keeps playing while it fades out).
func is_ambient_playing() -> bool:
	return not _ambient_key.is_empty() and _ambient_players[_active_player].playing


## The looping ambience for [param key] (see [method ambient_key_for]): the base loop of its
## lighting. Built in [method _ready]; before that it is synthesised on the spot.
func ambient_stream(key: String) -> AudioStreamWAV:
	var lighting: String = _key_part(key, 1)
	if not LIGHTING_NOISE.has(lighting):
		lighting = ""
	if not _bank.has(lighting):
		_bank[lighting] = _synth_ambient(lighting)
	return _bank[lighting] as AudioStreamWAV


## The pitch of the ambience for [param key]: lower in darker periods, and each place shifted by
## up to ±2 semitones so neighbouring rooms sound apart.
static func ambient_pitch(key: String) -> float:
	var semitones: int = posmod(_key_part(key, 0).hash(), 5) - 2
	var period: float = PERIOD_PITCH.get(_key_part(key, 2), 1.0) as float
	return period * pow(2.0, semitones / 12.0)


## The one-shot sound for the stinger [param kind]. Built in [method _ready]; before that it is
## synthesised on the spot.
func stinger_stream(kind: StringName) -> AudioStreamWAV:
	if not _bank.has(kind):
		_bank[kind] = _synth_stinger(kind)
	return _bank[kind] as AudioStreamWAV


func _set_ambient(key: String) -> void:
	if key == _ambient_key:
		return
	_ambient_key = key
	ambient_changed.emit(key)
	# Before _ready there are no players yet; _ready starts the ambience.
	if is_node_ready():
		_crossfade()


func _crossfade() -> void:
	if _fade != null and _fade.is_valid():
		_fade.kill()
	_fade = create_tween().set_parallel(true)
	_fade.tween_interval(0.0)
	var incoming: AudioStreamPlayer = null
	if not _ambient_key.is_empty():
		_active_player = 1 - _active_player
		incoming = _ambient_players[_active_player]
		incoming.stream = ambient_stream(_ambient_key)
		incoming.pitch_scale = ambient_pitch(_ambient_key)
		incoming.volume_db = SILENT_DB
		incoming.play()
		_fade.tween_property(incoming, ^"volume_db", AMBIENT_VOLUME_DB, AMBIENT_FADE_SECONDS)
	# Every other loop fades out, including one cut short by an earlier, interrupted crossfade.
	for player: AudioStreamPlayer in _ambient_players:
		if player != incoming and player.playing:
			_fade.tween_property(player, ^"volume_db", SILENT_DB, AMBIENT_FADE_SECONDS)
			_fade.tween_callback(_stop_if_inactive.bind(player)).set_delay(AMBIENT_FADE_SECONDS)


func _stop_if_inactive(player: AudioStreamPlayer) -> void:
	if player != _ambient_players[_active_player] or _ambient_key.is_empty():
		player.stop()


func _forget_session() -> void:
	_last_sanity = null
	_last_static = null


func _on_view_changed(view: Dictionary, _state_version: int) -> void:
	show_view(view)


func _on_event_received(event: Dictionary) -> void:
	var kind: String = str(event.get("type", ""))
	if kind == ProtocolConstants.EVENT_INCOMING_CALL:
		play_stinger(STINGER_INCOMING_CALL)
	elif kind == ProtocolConstants.EVENT_GAME_OVER:
		play_stinger(STINGER_GAME_OVER)


func _on_connection_state_changed(state: BackendScript.ConnectionState) -> void:
	# OFFLINE ends the session and clears the store without a new view.
	if state == BackendScript.ConnectionState.OFFLINE:
		_forget_session()
		_set_ambient("")


static func _text(value: Variant) -> String:
	if value is String:
		return value
	return ""


static func _key_part(key: String, index: int) -> String:
	var parts: PackedStringArray = key.split("|")
	return parts[index] if parts.size() > index else ""


# --- Placeholder synthesis (replaced by CNT-011 assets) -------------------------------------------


static func _synth_ambient(lighting: String) -> AudioStreamWAV:
	var length: int = AMBIENT_MIX_RATE * AMBIENT_LOOP_SECONDS
	# Whole cycles per loop keep the drone seamless at any pitch.
	var cycles: float = roundf(AMBIENT_FREQUENCY * AMBIENT_LOOP_SECONDS)
	var fifth: float = roundf(cycles * 1.5) + 1.0
	var noise_level: float = LIGHTING_NOISE.get(lighting, DEFAULT_NOISE) as float
	var rng: RandomNumberGenerator = RandomNumberGenerator.new()
	rng.seed = ("ambient|" + lighting).hash()
	# Dark (brown) noise, its tail blended into its head so the loop has no seam.
	var blend: int = floori(AMBIENT_MIX_RATE * 0.25)
	var brown: PackedFloat32Array = PackedFloat32Array()
	brown.resize(length + blend)
	var walk: float = 0.0
	for i: int in length + blend:
		walk = clampf(walk * 0.995 + rng.randf_range(-0.06, 0.06), -1.0, 1.0)
		brown[i] = walk
	var samples: PackedFloat32Array = PackedFloat32Array()
	samples.resize(length)
	for i: int in length:
		var phase: float = TAU * float(i) / float(length)
		var noise: float = brown[i]
		if i < blend:
			var weight: float = float(i) / float(blend)
			noise = brown[i] * weight + brown[length + i] * (1.0 - weight)
		var drone: float = sin(phase * cycles) * 0.6 + sin(phase * fifth) * 0.25
		var breath: float = 0.75 + 0.25 * sin(phase)
		samples[i] = drone * 0.35 * breath + noise * noise_level * 2.0
	return _to_wav(samples, AMBIENT_MIX_RATE, true)


static func _synth_stinger(kind: StringName) -> AudioStreamWAV:
	var seconds: float = 1.4
	if kind == STINGER_GAME_OVER:
		seconds = 2.6
	elif kind == STINGER_STATIC_THRESHOLD:
		seconds = 0.9
	var length: int = int(STINGER_MIX_RATE * seconds)
	var rng: RandomNumberGenerator = RandomNumberGenerator.new()
	rng.seed = String(kind).hash()
	var samples: PackedFloat32Array = PackedFloat32Array()
	samples.resize(length)
	var phase_a: float = 0.0
	var phase_b: float = 0.0
	var gate: float = 1.0
	for i: int in length:
		var t: float = float(i) / float(STINGER_MIX_RATE)
		var progress: float = t / seconds
		var value: float = 0.0
		if kind == STINGER_SANITY_DROP:
			# A dissonant low swell that cuts off.
			var swell: float = smoothstep(0.0, 0.75, progress) * (1.0 - smoothstep(0.75, 1.0, progress))
			value = (sin(TAU * 110.0 * t) + sin(TAU * 116.5 * t) + rng.randf_range(-0.3, 0.3)) * swell * 0.45
		elif kind == STINGER_STATIC_THRESHOLD:
			# A crackling burst of noise.
			if i % 441 == 0:
				gate = 1.0 if rng.randf() < 0.55 else 0.15
			value = rng.randf_range(-1.0, 1.0) * gate * (1.0 - progress) * 0.6
		elif kind == STINGER_INCOMING_CALL:
			# A detuned two-tone ring out of the noise.
			var ring: float = 1.0 if fmod(t, 0.35) < 0.22 else 0.0
			phase_a += TAU * 440.0 / STINGER_MIX_RATE
			phase_b += TAU * 466.0 / STINGER_MIX_RATE
			value = ((sin(phase_a) + sin(phase_b)) * 0.3 * ring + rng.randf_range(-0.1, 0.1)) * (1.0 - progress)
		else:
			# Game over: a long tone sinking an octave.
			phase_a += TAU * lerpf(98.0, 49.0, progress) / STINGER_MIX_RATE
			value = (sin(phase_a) * 0.6 + rng.randf_range(-0.15, 0.15)) * (1.0 - progress)
		samples[i] = value
	return _to_wav(samples, STINGER_MIX_RATE, false)


static func _to_wav(samples: PackedFloat32Array, mix_rate: int, looped: bool) -> AudioStreamWAV:
	var data: PackedByteArray = PackedByteArray()
	data.resize(samples.size() * 2)
	for i: int in samples.size():
		data.encode_s16(i * 2, int(clampf(samples[i], -1.0, 1.0) * 32767.0))
	var wav: AudioStreamWAV = AudioStreamWAV.new()
	wav.format = AudioStreamWAV.FORMAT_16_BITS
	wav.mix_rate = mix_rate
	wav.stereo = false
	wav.data = data
	if looped:
		wav.loop_mode = AudioStreamWAV.LOOP_FORWARD
		wav.loop_begin = 0
		wav.loop_end = samples.size()
	return wav
