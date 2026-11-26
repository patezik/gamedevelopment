extends GutTest
## The pairing QR comes from the server matrix as is: one texture pixel per module, a white
## four-module quiet zone, black and white only, and no mipmaps. The fixture is the output of the
## server's renderMatrix for `hs1:pair:192.168.1.20:7420:K7M2QX` (apps/server/src/qr/matrix.ts).

const QrTexture = preload("res://src/scenes/overlays/evidence_capture/qr_texture.gd")
const FIXTURE: String = "res://tests/fixtures/pairing_qr.json"
## Four modules of quiet zone around the symbol (ISO/IEC 18004); not read from the code under test.
const QUIET: int = 4

var matrix: Dictionary


func before_each() -> void:
	matrix = JSON.parse_string(FileAccess.get_file_as_string(FIXTURE)) as Dictionary


func test_every_module_is_one_pixel_inside_a_white_quiet_zone() -> void:
	var side: int = matrix["size"] as int
	var modules: String = matrix["modules"] as String
	var texture: ImageTexture = QrTexture.from_response(matrix)
	assert_not_null(texture)
	var width: int = side + QUIET * 2
	assert_eq(texture.get_width(), width)
	assert_eq(texture.get_height(), width)
	var image: Image = texture.get_image()
	assert_false(image.has_mipmaps(), "no mipmaps: nothing blends modules")
	var mismatches: int = 0
	var dark: int = 0
	for y: int in range(width):
		for x: int in range(width):
			var row: int = y - QUIET
			var column: int = x - QUIET
			var inside: bool = row >= 0 and row < side and column >= 0 and column < side
			var expected: Color = Color.WHITE
			if inside and modules[row * side + column] == "1":
				expected = Color.BLACK
				dark += 1
			if not image.get_pixel(x, y).is_equal_approx(expected):
				mismatches += 1
	assert_eq(mismatches, 0, "each pixel equals its server module or the quiet zone")
	assert_eq(dark, modules.count("1"))


func test_a_matrix_of_another_shape_gives_no_texture() -> void:
	var side: int = matrix["size"] as int
	var modules: String = matrix["modules"] as String
	assert_null(QrTexture.from_response({"size": side, "modules": modules.substr(1)}))
	assert_null(QrTexture.from_response({"size": side + 1, "modules": modules}))
	assert_null(QrTexture.from_response({"size": side, "modules": "2" + modules.substr(1)}))
	assert_null(QrTexture.from_response({"size": side, "modules": modules, "payload": "x"}))
	assert_null(QrTexture.from_response({"error": {"code": "PAIRING_CODE_EXPIRED", "message": ""}}))
	assert_null(QrTexture.from_response(null))
