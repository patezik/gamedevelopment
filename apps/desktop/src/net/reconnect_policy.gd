extends RefCounted

const MAX_DELAY: float = 8.0


static func delay(attempt: int, jitter: float) -> float:
	var base: float = 0.5 * pow(2.0, float(clampi(attempt, 0, 4)))
	return minf(MAX_DELAY, base * (1.0 + clampf(jitter, -0.2, 0.2)))
