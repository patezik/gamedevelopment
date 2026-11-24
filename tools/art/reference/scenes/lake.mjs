// loc_lake_path «Тропа к озеру»: расчищенная тропа между соснами, обледенелые ступени,
// беседка, фонари вдоль тропы (один не горит), мостки на замёрзшем озере, «белая тишина».
// Lighting from locations.json: dim (morning, day), dark (evening, night).

import { Frame, fbm, hash, hex, mix, mul, smooth, vnoise } from '../raster.mjs';

const W = 384;
const H = 216;
const SHORE = -27;
const LAMP = [1, 0.76, 0.42];

const pathX = (z) => 0.7 * Math.sin(z * 0.09) - 0.3;

const TREES = [
  [-3.2, -3.4, 0.34],
  [3.6, -4.2, 0.3],
  [-5.6, -7.5, 0.28],
  [4.6, -9.5, 0.26],
  [-2.8, -18.5, 0.22],
  [3.1, -17.0, 0.24],
  [-7.5, -12.0, 0.3],
  [7.8, -15.0, 0.3],
  [-4.8, -24.0, 0.24],
  [5.4, -25.5, 0.24],
  [-2.6, -24.5, 0.2],
  [3.0, -23.5, 0.2],
  [-8.5, -22.0, 0.26],
  [8.8, -25.0, 0.26],
].sort((a, b) => a[1] - b[1]); // far first: painter's order

const LAMPS = [-7.5, -13.5, -19, -24.5].map((z, i) => ({
  pos: [pathX(z) + 1.35, 2.85, z],
  on: i !== 2,
}));

function ground(p) {
  const d = Math.abs(p[0] - pathX(p[2]));
  const trodden = 1 - smooth(0.55, 0.95, d);
  const drift = 0.92 + fbm(p[0] * 0.8, p[2] * 0.8, 3) * 0.16;
  const tracks = trodden > 0.5 && vnoise(p[0] * 7, p[2] * 2, 5) > 0.7 ? 0.82 : 1;
  return { albedo: mul(mix(hex('#d7ddd6'), hex('#8e9a98'), trodden * 0.7), drift * tracks) };
}

function lake(p) {
  const crack = Math.abs(fbm(p[0] * 0.5, p[2] * 0.25, 13) - 0.5) < 0.012;
  const snowPatch = fbm(p[0] * 0.3, p[2] * 0.3, 17) > 0.55;
  return { albedo: crack ? hex('#333e47') : snowPatch ? hex('#b9c2bc') : hex('#7f8f92') };
}

/** Scots pine of the «бор»: a tall bare trunk; the crown sits high, mostly above the frame. */
function pine(f, [x, z, r], night) {
  for (let k = 0; k < 3; k++) {
    f.ellipsoid([x + (k - 1) * 1.1, 13 + k * 1.4, z], [2.4 - k * 0.4, 1.1, 2.0], (p, n) => {
      const ragged = fbm(p[0] * 1.5, p[1] * 1.5, 41 + k);
      if (ragged > 0.62 && Math.abs(n[1]) < 0.5) return null;
      return {
        albedo:
          n[1] > 0.5 ? hex(night ? '#93a19f' : '#c9d0c8') : mul(hex('#1c2420'), 0.8 + ragged * 0.4),
      };
    });
  }
  f.cylinder([x, z], r, 0, 14, (p) => {
    const bark = 0.7 + vnoise(p[1] * 5, Math.atan2(p[0] - x, p[2] - z) * 3, 7) * 0.45;
    // Scots pine bark: grey-brown below, warmer higher up, snow plastered on the windward side.
    const warm = mix(hex('#2b241f'), hex('#5e4434'), Math.min(1, p[1] / 9));
    const plastered = p[0] - x < -r * 0.75 && vnoise(p[1] * 3, x, 9) > 0.72;
    return { albedo: plastered ? hex('#b9c2bc') : mul(warm, bark) };
  });
}

/** Young spruce: stacked drooping tiers form a cone; snow rests on the upper sides. */
function spruce(f, [x, z, height], night) {
  const tiers = Math.round(height / 0.38);
  for (let k = 0; k < tiers; k++) {
    const y = 0.35 + k * 0.38;
    const radius = 0.95 * (1 - k / tiers) * (height / 3) + 0.08;
    f.ellipsoid([x, y, z], [radius, 0.32, radius], (p, n) => {
      const ragged = fbm(Math.atan2(p[0] - x, p[2] - z) * 4 + k, p[1] * 5, 23 + k);
      if (Math.abs(n[1]) < 0.3 && ragged > 0.6) return null;
      const snow = n[1] > 0.45 + ragged * 0.3;
      return {
        albedo: snow
          ? hex(night ? '#93a19f' : '#dfe4dc')
          : mul(hex('#1c2420'), 0.75 + ragged * 0.5),
      };
    });
  }
}

const SPRUCES = [
  [-7.8, -11, 2.6],
  [2.7, -12.5, 2.2],
  [-6.4, -19, 3.2],
  [3.8, -21, 2.8],
  [-2.4, -21.5, 1.8],
  [6.5, -8, 3.4],
];

export function render(lighting) {
  const night = lighting === 'dark';
  const f = new Frame(W, H, { eye: 2.1, horizon: 84, focal: 230 });
  const skyTop = night ? hex('#0a0c0f') : hex('#93a19f');
  const skyLow = night ? hex('#222a32') : hex('#cfd5cd');
  f.polygon(
    [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ],
    (x, y, i) => f.glowPixel(i, mix(skyTop, skyLow, smooth(0, 90, y))),
  );

  // Far shore treeline: a fogged silhouette band just above the horizon.
  f.polygon(
    [
      [0, 70],
      [W, 70],
      [W, 88],
      [0, 88],
    ],
    (x, y, i) => {
      const top = 84 - fbm(x * 0.08, 0, 61) * 14 - (hash(x >> 1, 0, 63) > 0.7 ? 3 : 0);
      if (y >= top) f.glowPixel(i, night ? hex('#151a20') : hex('#8f9c99'));
    },
  );

  f.quad(
    [
      [-60, 0, SHORE],
      [60, 0, SHORE],
      [60, 0, -160],
      [-60, 0, -160],
    ],
    lake,
  );
  f.quad(
    [
      [-40, 0, -0.4],
      [40, 0, -0.4],
      [40, 0, SHORE],
      [-40, 0, SHORE],
    ],
    ground,
  );

  // Pier over the ice.
  f.box([-0.9, 0.12, SHORE - 9], [0.3, 0.22, SHORE - 0.3], (p, n, face) => ({
    albedo:
      face === 'top' ? (((p[2] * 3) | 0) % 2 ? hex('#c9d0c8') : hex('#b9c2bc')) : hex('#3b2819'),
  }));

  // Gazebo: four posts, bench, snowy pyramid roof.
  const g = { x: -4.4, z: -15.0, half: 1.1 };
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    f.cylinder([g.x + sx * g.half, g.z + sz * g.half], 0.07, 0, 2.3, () => ({
      albedo: hex('#3b2819'),
    }));
  }
  f.box([g.x - 0.9, 0.42, g.z - 0.95], [g.x + 0.9, 0.5, g.z - 0.6], () => ({
    albedo: hex('#634328'),
  }));
  const apex = [g.x, 3.4, g.z];
  const e = g.half + 0.35;
  const eaves = [
    [g.x - e, 2.3, g.z + e],
    [g.x + e, 2.3, g.z + e],
    [g.x + e, 2.3, g.z - e],
    [g.x - e, 2.3, g.z - e],
  ];
  for (let k = 0; k < 4; k++) {
    const a = eaves[k];
    const b = eaves[(k + 1) % 4];
    f.quad([a, b, apex, apex], (p) => ({ albedo: p[1] > 2.4 ? hex('#d7ddd6') : hex('#3b2819') }));
  }

  // Lamp posts along the path; the third one is dead.
  for (const l of LAMPS) {
    f.cylinder([l.pos[0], l.pos[2]], 0.05, 0, 2.9, () => ({ albedo: hex('#222a32') }));
    f.ellipsoid([l.pos[0], 2.98, l.pos[2]], [0.16, 0.12, 0.16], (p, n) =>
      night && l.on && n[1] < 0.3
        ? { albedo: [0, 0, 0], emit: hex('#e3cb94') }
        : { albedo: hex('#333e47') },
    );
  }

  // Painter's order across both kinds of trees: far to near.
  const trees = [
    ...TREES.map((t) => ({ z: t[1], draw: () => pine(f, t, night) })),
    ...SPRUCES.map((s) => ({ z: s[1], draw: () => spruce(f, s, night) })),
  ].sort((a, b) => a.z - b.z);
  for (const t of trees) t.draw();

  // Icy steps down from the camera, with a handrail.
  // Each step runs back to the camera; the lowest is painted first so higher ones overlap it.
  for (let k = 3; k >= 0; k--) {
    const top = 0.6 - k * 0.15;
    const z0 = -3.0 - k * 0.8;
    f.box([-1.6, 0, z0 - 0.8], [0.5, top, -0.4], (p, n, face) => {
      if (face === 'top') {
        if (p[2] < z0 - 0.68) return { albedo: hex('#3b2819') }; // worn wooden nosing
        const glaze = vnoise(p[0] * 5, p[2] * 5, 71 + k) > 0.66;
        return { albedo: glaze ? hex('#ece7da') : hex('#aab5b0') };
      }
      return { albedo: hex('#3b2819') };
    });
  }
  for (const z of [-1.4, -3.2, -4.8, -6.4])
    f.box([-1.8, 0, z - 0.06], [-1.7, 1.45, z + 0.06], () => ({ albedo: hex('#2a1d14') }));
  f.box([-1.81, 1.4, -6.5], [-1.69, 1.48, -0.4], () => ({ albedo: hex('#3b2819') }));

  const lights = night
    ? LAMPS.filter((l) => l.on).map((l) => ({
        type: 'point',
        pos: l.pos,
        color: LAMP,
        intensity: 2.2,
        range: 7,
        wrap: 0.3,
      }))
    : [];
  f.shade({
    lights,
    ambient: night
      ? { sky: hex('#333e47'), ground: hex('#151a20') }
      : { sky: hex('#b9c2bc'), ground: hex('#6a7a7f') },
    fog: night
      ? { color: hex('#2a333b'), near: 6, far: 40, max: 0.85 }
      : { color: hex('#c9d0c8'), near: 5, far: 42, max: 0.92 },
  });
  if (night)
    for (const l of LAMPS.filter((x) => x.on))
      f.halo([l.pos[0], 2.98, l.pos[2]], mul(LAMP, 0.3), 9);

  // Falling snow: sparse specks, brighter near lamps at night.
  f.post((x, y, c) => {
    if (hash(x, y, 91) < 0.985) return c;
    const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    const flake = night ? (lum > 0.18 ? hex('#ece7da') : hex('#4a5860')) : hex('#ece7da');
    return flake;
  });
  return f.finish({ vignette: night ? 0.6 : 0.3, seed: 303 });
}
