shader_type canvas_item;
render_mode unshaded;

// Horror screen effect (GDT-010): a full-screen pass over what the screens below have drawn.
// `distortion` follows low sanity (waver, colour split, darkened edges); `noise` follows Static
// (grain, scan lines, a tearing band). Both are 0..1 and come from HorrorFx; 0/0 draws the
// screen unchanged. TIME is real time and only animates the picture.

uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;
uniform float distortion : hint_range(0.0, 1.0) = 0.0;
uniform float noise : hint_range(0.0, 1.0) = 0.0;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void fragment() {
	vec2 uv = SCREEN_UV;
	float t = TIME;

	// Low sanity: a slow horizontal waver of the whole picture.
	float wave = sin(uv.y * 17.0 + t * 1.3) * 0.6 + sin(uv.y * 43.0 - t * 2.1) * 0.4;
	uv.x += wave * 0.0035 * distortion;

	// Static: now and then a thin band of the picture slips sideways.
	float band_y = fract(t * 0.19);
	float band_on = step(0.6, hash(vec2(floor(t * 5.0), 3.0)));
	float band = (1.0 - smoothstep(0.0, 0.025, abs(uv.y - band_y))) * band_on;
	uv.x += band * 0.025 * noise;

	// Colour channels drift apart.
	float split = 0.0025 * distortion + 0.0015 * noise;
	vec3 color;
	color.r = texture(screen_texture, uv + vec2(split, 0.0)).r;
	color.g = texture(screen_texture, uv).g;
	color.b = texture(screen_texture, uv - vec2(split, 0.0)).b;

	// Static: animated grain and scan lines.
	float grain = hash(floor(FRAGCOORD.xy * 0.5) + vec2(floor(t * 24.0) * 7.0, 0.0)) - 0.5;
	color += grain * 0.2 * noise;
	color *= 1.0 - 0.1 * noise * step(0.5, fract(FRAGCOORD.y * 0.5));

	// Low sanity: the edges of the screen close in.
	vec2 centered = SCREEN_UV - 0.5;
	color *= 1.0 - clamp(dot(centered, centered) * 1.8 * distortion, 0.0, 1.0);

	COLOR = vec4(color, 1.0);
}
