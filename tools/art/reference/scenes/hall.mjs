// loc_hall «Холл»: колонны, паркет семидесятых, стойка администратора под лампой дневного
// света, камин, бюст основателя, стационарный телефон, выцветшая карта маршрутов.
// Lighting from locations.json: bright (morning, day), dim (evening, night).

import { Frame, fbm, hash, hex, mix, mul, vnoise } from '../raster.mjs';

const W = 384;
const H = 216;
const BACK = -11;
const ROOM = { x0: -4.2, x1: 4.2, ceil: 3.4 };
const TUBE = [0.8, 0.9, 0.84];
const FIRE = [1, 0.58, 0.28];

const plaster = hex('#56665f');
const panel = hex('#3d2a1c');
const parquet = hex('#6b4a2c');
const rug = hex('#3e2c22');

function parquetAt(p) {
  // Herringbone-like planks: alternating diagonal boards in 0.6 m cells.
  const cx = Math.floor(p[0] / 0.45);
  const cz = Math.floor(p[2] / 0.45);
  const lx = p[0] / 0.45 - cx;
  const lz = p[2] / 0.45 - cz;
  const diag = (cx + cz) & 1 ? lx : lz;
  const board = Math.floor(diag * 4);
  const tone = 0.86 + hash(cx * 4 + board, cz, 3) * 0.2;
  const seam = (diag * 4) % 1 < 0.12 ? 0.55 : 1;
  const wear = 1 + 0.25 * Math.exp(-(p[0] * p[0]) / 2.5);
  return mul(parquet, tone * seam * wear);
}

function floor(p) {
  if (Math.abs(p[0] + 0.2) < 0.75 && p[2] > -9) {
    const stripe = Math.abs(Math.abs(p[0] + 0.2) - 0.62) < 0.05;
    const worn = 0.85 + vnoise(p[0] * 9, p[2] * 9, 5) * 0.3;
    return { albedo: stripe ? mul(hex('#8f6639'), worn) : mul(rug, worn) };
  }
  return { albedo: parquetAt(p) };
}

function wall(p, n) {
  const along = n[2] !== 0 ? p[0] : p[2];
  if (p[1] < 1.1) {
    const seam = (along * 1.25) % 1 < 0.04 || p[1] > 1.05 ? 0.6 : 1;
    return { albedo: mul(panel, seam * (0.9 + fbm(along * 6, p[1] * 2, 7) * 0.25)) };
  }
  const stain = 0.86 + fbm(along * 1.3, p[1] * 1.6, 11) * 0.28;
  const damp = p[1] > 3.0 ? 0.85 : 1;
  return { albedo: mul(plaster, stain * damp) };
}

function ceiling(p) {
  const beam = Math.abs(((p[2] + 100) % 2.75) - 1.375) > 1.25 ? 0.7 : 1;
  return { albedo: mul(hex('#4e5a5c'), beam * (0.9 + fbm(p[0], p[2], 13) * 0.2)) };
}

function routeMap(p) {
  // The faded forest map: paper, contour blobs, a dotted route.
  const u = (p[0] - 1.1) / 1.7;
  const v = (p[1] - 1.45) / 1.0;
  if (u < 0.03 || u > 0.97 || v < 0.04 || v > 0.96) return { albedo: hex('#2e2117') };
  const h = fbm(u * 3, v * 3, 21, 4);
  const contour = Math.abs(((h * 9) % 1) - 0.5) < 0.08 ? 0.72 : 1;
  const lake = h < 0.36 ? mix(hex('#8d9a96'), hex('#6a7a7f'), 0.5) : hex('#b2a27c');
  const route = Math.abs(v - 0.5 - Math.sin(u * 6) * 0.18) < 0.03 && Math.floor(u * 30) % 2 === 0;
  return { albedo: route ? hex('#6f211d') : mul(lake, contour) };
}

function window(p, night) {
  // Left wall window: z −7.6…−4.6, y 0.9…3.0, mullions every 0.75 m.
  const mz = Math.abs(((p[2] + 100) % 0.75) - 0.375) > 0.34;
  const my = Math.abs(p[1] - 2.2) < 0.04;
  if (mz || my) return { albedo: hex('#2c241c') };
  const snow = vnoise(p[2] * 18, p[1] * 18, 31) > 0.82;
  const sky = night
    ? mix(hex('#151a20'), hex('#222a32'), (p[1] - 0.9) / 2.1)
    : mix(hex('#c9d0c8'), hex('#93a19f'), (p[1] - 0.9) / 2.1);
  const pines =
    vnoise(p[2] * 3, 0, 33) * 0.9 + 1.0 > p[1] ? (night ? hex('#0a0c0f') : hex('#4a5860')) : sky;
  return { albedo: [0, 0, 0], emit: snow ? (night ? hex('#4a5860') : hex('#ece7da')) : pines };
}

export function render(lighting) {
  const night = lighting !== 'bright';
  const f = new Frame(W, H, { eye: 1.55, horizon: 94, focal: 230 });
  const { x0, x1, ceil } = ROOM;
  const near = -0.6;

  f.quad(
    [
      [x0, 0, near],
      [x1, 0, near],
      [x1, 0, BACK],
      [x0, 0, BACK],
    ],
    floor,
  );
  f.quad(
    [
      [x0, ceil, near],
      [x1, ceil, near],
      [x1, ceil, BACK],
      [x0, ceil, BACK],
    ],
    ceiling,
  );
  f.quad(
    [
      [x0, 0, BACK],
      [x1, 0, BACK],
      [x1, ceil, BACK],
      [x0, ceil, BACK],
    ],
    wall,
  );
  f.quad(
    [
      [x0, 0, near],
      [x0, 0, BACK],
      [x0, ceil, BACK],
      [x0, ceil, near],
    ],
    (p, n) =>
      p[2] > -7.6 && p[2] < -4.6 && p[1] > 0.9 && p[1] < 3.0 ? window(p, night) : wall(p, n),
  );
  f.quad(
    [
      [x1, 0, near],
      [x1, 0, BACK],
      [x1, ceil, BACK],
      [x1, ceil, near],
    ],
    wall,
  );

  // Faded route map and key rack on the back wall.
  f.quad(
    [
      [1.1, 1.45, BACK + 0.02],
      [2.8, 1.45, BACK + 0.02],
      [2.8, 2.45, BACK + 0.02],
      [1.1, 2.45, BACK + 0.02],
    ],
    routeMap,
  );
  f.quad(
    [
      [-2.5, 1.45, BACK + 0.02],
      [-0.9, 1.45, BACK + 0.02],
      [-0.9, 2.15, BACK + 0.02],
      [-2.5, 2.15, BACK + 0.02],
    ],
    (p) => {
      const hook = ((p[0] + 10) * 5) % 1 < 0.25 && (p[1] * 4) % 1 < 0.35;
      return { albedo: hook ? hex('#bd955a') : hex('#3b2819') };
    },
  );

  // Fireplace on the right wall.
  f.box([3.55, 0, -7.4], [4.2, 1.35, -5.6], (p, n, face) => {
    if (face === 'left' && p[2] > -7.0 && p[2] < -6.0 && p[1] < 0.9) {
      const ember = night
        ? Math.max(0, 0.9 - p[1] * 1.6) * (0.6 + vnoise(p[2] * 14, p[1] * 10, 41) * 0.8)
        : 0;
      return { albedo: hex('#0a0c0f'), emit: mul(FIRE, ember) };
    }
    const brick =
      (p[1] * 8) % 1 < 0.1 || (p[2] * 4 + Math.floor(p[1] * 8) * 0.5) % 1 < 0.06 ? 0.6 : 1;
    return { albedo: mul(hex('#5f574e'), brick) };
  });
  f.box([3.45, 1.35, -7.55], [4.2, 1.45, -5.45], () => ({ albedo: hex('#3b2819') }));

  // Reception desk with the stationary phone and a ledger.
  f.box([-2.7, 0, -9.7], [-0.3, 1.1, -8.8], (p, n, face) => {
    if (face === 'top') return { albedo: hex('#8f6639') };
    const pane = ((p[0] + 10) * 1.6) % 1 < 0.06 || p[1] < 0.08 ? 0.55 : 1;
    return { albedo: mul(hex('#4a3020'), pane) };
  });
  // The stationary phone is a narrative object: the only rust-accent surface in the plate (§3).
  f.box([-1.25, 1.1, -9.15], [-0.7, 1.24, -8.9], () => ({ albedo: hex('#7a2420'), accent: true }));
  f.ellipsoid([-0.97, 1.28, -9.02], [0.26, 0.06, 0.08], () => ({
    albedo: hex('#8a2a24'),
    accent: true,
  }));
  // Brass desk lamp: keeps the desk readable in dim light (§5).
  f.cylinder([-2.35, -9.1], 0.03, 1.1, 1.45, () => ({ albedo: hex('#8f6639') }));
  f.ellipsoid([-2.3, 1.48, -9.05], [0.16, 0.09, 0.12], (p, n) =>
    n[1] < -0.2 ? { albedo: [0, 0, 0], emit: hex('#e3cb94') } : { albedo: hex('#8f6639') },
  );
  f.box([-2.2, 1.1, -9.3], [-1.6, 1.14, -8.95], () => ({ albedo: hex('#c9c0a8') }));

  // Hanging fluorescent fixtures; the one over the desk always burns.
  const tubes = [
    { a: [-2.4, 2.95, -8.3], b: [-0.6, 2.95, -8.3], on: true },
    { a: [-0.9, 2.95, -5.0], b: [0.9, 2.95, -5.0], on: !night },
  ];
  for (const t of tubes) {
    f.box([t.a[0], 2.92, t.a[2] - 0.12], [t.b[0], 3.0, t.a[2] + 0.12], (p, n, face) =>
      face === 'bottom'
        ? { albedo: [0, 0, 0], emit: t.on ? mul(TUBE, 1.3) : hex('#333e47') }
        : { albedo: hex('#4a5860') },
    );
    f.box([t.a[0] + 0.1, 3.0, t.a[2] - 0.01], [t.a[0] + 0.12, ceil, t.a[2] + 0.01], () => ({
      albedo: hex('#151a20'),
    }));
    f.box([t.b[0] - 0.12, 3.0, t.a[2] - 0.01], [t.b[0] - 0.1, ceil, t.a[2] + 0.01], () => ({
      albedo: hex('#151a20'),
    }));
  }

  // Bust of the founder on a plinth.
  f.box([1.75, 0, -8.35], [2.35, 1.15, -7.8], () => ({ albedo: hex('#4a4440') }));
  f.ellipsoid([2.05, 1.32, -8.05], [0.3, 0.18, 0.18], () => ({ albedo: hex('#b8b6a8') }));
  f.ellipsoid([2.05, 1.62, -8.05], [0.14, 0.19, 0.15], (p, n, u) => ({
    albedo: mul(hex('#c2c0b2'), u[1] > 0.45 && u[2] < 0.7 ? 0.85 : 1),
  }));

  // Columns (two pairs) with darker plinths.
  for (const [cx, cz] of [
    [-2.95, -8.1],
    [2.95, -8.1],
    [-2.95, -4.0],
    [2.95, -4.0],
  ]) {
    f.cylinder([cx, cz], 0.32, 0, ceil, (p) => {
      const flute = 0.88 + 0.12 * Math.cos(Math.atan2(p[0] - cx, p[2] - cz) * 12);
      const base = p[1] < 0.35 || p[1] > ceil - 0.25 ? 0.7 : 1;
      return { albedo: mul(hex('#8a8c82'), flute * base * (0.9 + fbm(p[1] * 2, cx, 51) * 0.2)) };
    });
  }

  const lights = [
    {
      type: 'point',
      pos: [-2.3, 1.36, -8.9],
      color: [1, 0.8, 0.5],
      intensity: night ? 1.4 : 0.6,
      range: 2.6,
    },
    {
      type: 'tube',
      a: tubes[0].a,
      b: tubes[0].b,
      color: TUBE,
      intensity: night ? 2.4 : 2.0,
      range: 9,
    },
  ];
  if (!night) {
    lights.push({
      type: 'tube',
      a: tubes[1].a,
      b: tubes[1].b,
      color: TUBE,
      intensity: 1.6,
      range: 9,
    });
    lights.push({
      type: 'point',
      pos: [-3.9, 2.0, -6.1],
      color: [0.75, 0.82, 0.9],
      intensity: 1.6,
      range: 8,
      wrap: 0.4,
    });
  } else {
    lights.push({
      type: 'point',
      pos: [3.3, 0.45, -6.5],
      color: FIRE,
      intensity: 2.2,
      range: 5.5,
      wrap: 0.3,
    });
  }

  f.shade({
    lights,
    ambient: night
      ? { sky: hex('#151a20'), ground: hex('#0a0c0f') }
      : { sky: hex('#4a5860'), ground: hex('#333e47') },
    fog: { color: night ? hex('#0a0c0f') : hex('#333e47'), near: 6, far: 16, max: 0.45 },
  });
  f.halo(mix(tubes[0].a, tubes[0].b, 0.5), mul(TUBE, 0.22), 26);
  if (!night) f.halo(mix(tubes[1].a, tubes[1].b, 0.5), mul(TUBE, 0.14), 30);
  else f.halo([3.5, 0.45, -6.5], mul(FIRE, 0.18), 18);
  return f.finish({ vignette: night ? 0.55 : 0.35, seed: 101 });
}
