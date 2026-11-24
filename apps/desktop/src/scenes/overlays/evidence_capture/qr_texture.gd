extends RefCounted
## Presentation of the server's row-major QR matrix (ADR 0010).

const Envelope = preload("res://src/net/envelope.gd")
const QUIET_ZONE: int = 4


static func from_response(body: Variant) -> ImageTexture:
	if not body is Dictionary:
		return null
	var data: Dictionary = body
	var side: int = Envelope.counter(data.get("size"))
	var raw: Variant = data.get("modules")
	# QR versions 1–40 use 21 to 177 modules, increasing by four per version.
	if data.size() != 2 or side < 21 or side > 177 or (side - 21) % 4 != 0 or not raw is String:
		return null
	var modules: String = raw
	if modules.length() != side * side:
		return null
	var width: int = side + QUIET_ZONE * 2
	var image: Image = Image.create_empty(width, width, false, Image.FORMAT_RGB8)
	image.fill(Color.WHITE)
	for row: int in range(side):
		for column: int in range(side):
			match modules[row * side + column]:
				"1":
					image.set_pixel(column + QUIET_ZONE, row + QUIET_ZONE, Color.BLACK)
				"0":
					pass
				_:
					return null
	return ImageTexture.create_from_image(image)
