extends Node
## Displays the shipped overlay with a sample QR for a physical-camera readability check.

const BackendScript = preload("res://src/autoload/backend.gd")
const Store = preload("res://src/autoload/game_store.gd")
const Overlay = preload("res://src/scenes/overlays/evidence_capture/evidence_capture.gd")
const CaptureScene = preload("res://src/scenes/overlays/evidence_capture/evidence_capture.tscn")
const TOKEN: String = "AAAAAAAAAAAAAAAA"


class PreviewBackend extends BackendScript:
	var next_id: int = 0

	func request_evidence_qr(_token_id: String) -> int:
		next_id += 1
		var matrix: Variant = JSON.parse_string(
			FileAccess.get_file_as_string("res://tests/fixtures/evidence_qr.json")
		)
		rest_completed.emit.call_deferred(next_id, HTTPRequest.RESULT_SUCCESS, 200, matrix)
		return next_id


func _ready() -> void:
	var backend: PreviewBackend = PreviewBackend.new()
	add_child(backend)
	var store: Store = Store.new()
	add_child(store)
	store.bind_backend(backend)
	var overlay: Overlay = CaptureScene.instantiate() as Overlay
	overlay.bind_sources(store, backend)
	add_child(overlay)
	overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	store.set_view({
		"phone": {"paired": true, "online": false},
		"pendingCapture": {
			"tokenId": TOKEN, "clueTitle": "Образец записи в журнале", "expiresInMinutes": 12,
		},
	}, 1)
