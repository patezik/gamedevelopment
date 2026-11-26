// loc_treatment «Процедурный корпус»: кафель, ванна подводного массажа, пост медсестры,
// дверь кабинета ЛФК, дежурная комната, трубы отопления под потолком.
// Lighting from locations.json: bright (morning, day), dim (evening), dark (night).
// The plate shows only permanent environment: no body, no stains (§5 "истина не в картинке").

import { Frame, fbm, hash, hex, mix, mul, vnoise } from '../raster.mjs';

const W = 384;
const H = 216;
const BACK = -10;
const X0 = -3.6;
const X1 = 3.6;
const CEIL = 3.2;
const TUBE = [0.78, 0.9, 0.84];
const LAMP = [1, 0.78, 0.48];
const MOON = [0.55, 0.66, 0.78];

function tiles(along, y, seed, size = 0.2) {
  const tx = Math.floor(along / size);
  const ty = Math.floor(y / size);
  const gx = (along / size) % 1;
  const gy = (y / size) % 1;
  const grout = gx < 0.08 || gy < 0.08;
  const chipped = hash(tx, ty, seed) > 0.985;
  const tone = 0.92 + hash(tx, ty, seed + 1) * 0.12;
  return { grout, chipped, tone };
}

function wall(p, n) {
  const along = n[2] !== 0 ? p[0] : p[2];
  if (p[1] < 2.0) {
    const t = tiles(along + 20, p[1], 3);
    if (t.grout) return { albedo: hex('#6a7a7f') };
    if (t.chipped) return { albedo: hex('#333e47') };
    const rust = p[1] < 0.25 ? 0.85 + fbm(along * 3, 0, 9) * 0.1 : 1;
    return { albedo: mul(hex('#b9c4bc'), t.tone * rust) };
  }
  if (p[1] < 2.06) return { albedo: hex('#4a5860') };
  return { albedo: mul(hex('#6f7f76'), 0.85 + fbm(along * 1.2, p[1] * 2, 13) * 0.3) };
}

function floor(p) {
  const t = tiles(p[0] + 20, p[2] + 40, 17, 0.3);
  const checker = (Math.floor((p[0] + 20) / 0.3) + Math.floor((p[2] + 40) / 0.3)) & 1;
  const base = checker ? hex('#5b6a6c') : hex('#7d8b88');
  const drain = Math.hypot(p[0] - 0.9, p[2] + 5.2) < 0.18;
  const wet = vnoise(p[0] * 1.5, p[2] * 1.5, 19) > 0.62 ? 0.82 : 1;
  if (drain) return { albedo: ((p[0] * 30) | 0) % 2 ? hex('#151a20') : hex('#333e47') };
  return { albedo: mul(base, (t.grout ? 0.7 : t.tone) * wet) };
}

export function render(lighting) {
  const f = new Frame(W, H, { eye: 1.55, horizon: 92, focal: 225 });
  const near = -0.6;
  const dim = lighting === 'dim';
  const dark = lighting === 'dark';

  f.quad(
    [
      [X0, 0, near],
      [X1, 0, near],
      [X1, 0, BACK],
      [X0, 0, BACK],
    ],
    floor,
  );
  f.quad(
    [
      [X0, CEIL, near],
      [X1, CEIL, near],
      [X1, CEIL, BACK],
      [X0, CEIL, BACK],
    ],
    (p) => ({
      albedo: mul(hex('#5d6966'), 0.85 + fbm(p[0] * 2, p[2], 23) * 0.3),
    }),
  );
  f.quad(
    [
      [X0, 0, BACK],
      [X1, 0, BACK],
      [X1, CEIL, BACK],
      [X0, CEIL, BACK],
    ],
    (p, n) => {
      // Door of the ЛФК room, left ajar: dark gap with a strip of the room beyond.
      if (p[0] > 1.0 && p[0] < 2.1 && p[1] < 2.15) {
        if (p[0] < 1.12 || p[0] > 1.98 || p[1] > 2.05) return { albedo: hex('#3b2819') };
        if (p[0] < 1.3) return { albedo: [0, 0, 0], emit: dark ? hex('#151a20') : hex('#222a32') };
        return { albedo: mul(hex('#93a19f'), 0.9) };
      }
      // Plaque above the door.
      if (p[0] > 1.25 && p[0] < 1.85 && p[1] > 2.3 && p[1] < 2.5) {
        const text = p[1] > 2.36 && p[1] < 2.44 && ((p[0] * 40) | 0) % 3 !== 0;
        return { albedo: text ? hex('#151a20') : hex('#bd955a') };
      }
      return wall(p, n);
    },
  );
  // Left wall: door of the duty room with a wired-glass window.
  f.quad(
    [
      [X0, 0, near],
      [X0, 0, BACK],
      [X0, CEIL, BACK],
      [X0, CEIL, near],
    ],
    (p, n) => {
      if (p[2] > -8.4 && p[2] < -7.2 && p[1] < 2.1) {
        if (p[2] < -8.3 || p[2] > -7.3 || p[1] > 2.0) return { albedo: hex('#3b2819') };
        if (p[1] > 1.2 && p[1] < 1.8 && p[2] > -8.1 && p[2] < -7.5) {
          const wire = ((p[2] * 20) | 0) % 2 === 0 && ((p[1] * 20) | 0) % 2 === 0;
          // At night a lamp is left on in the duty room: warm light through the wired glass.
          return {
            albedo: [0, 0, 0],
            emit: wire ? hex('#151a20') : dark ? hex('#b8977a') : hex('#4a5860'),
          };
        }
        return { albedo: hex('#8a8e84') };
      }
      return wall(p, n);
    },
  );
  // Right wall: high frosted window (the only light at night).
  f.quad(
    [
      [X1, 0, near],
      [X1, 0, BACK],
      [X1, CEIL, BACK],
      [X1, CEIL, near],
    ],
    (p, n) => {
      if (p[2] > -6.8 && p[2] < -4.2 && p[1] > 2.2 && p[1] < 2.95) {
        const bar = ((p[2] + 10) * 2.5) % 1 < 0.08;
        const frost = 0.7 + vnoise(p[2] * 12, p[1] * 12, 29) * 0.4;
        return {
          albedo: [0, 0, 0],
          emit: bar
            ? hex('#151a20')
            : mul(dark ? hex('#4a5860') : hex('#c9d0c8'), frost * (dim ? 0.55 : 1)),
        };
      }
      return wall(p, n);
    },
  );

  // Heating pipes under the ceiling along the right wall and across the back.
  for (const [y, z0, r] of [
    [2.85, -0.6, 0.07],
    [2.68, -0.6, 0.05],
  ]) {
    f.box([X1 - 0.35 - r, y - r, BACK], [X1 - 0.35 + r, y + r, z0], (p, n, face) => ({
      albedo: mul(hex('#5e5a50'), face === 'bottom' ? 0.6 : 1),
    }));
  }
  f.box([X0, 2.95, BACK + 0.2], [X1, 3.05, BACK + 0.35], () => ({ albedo: hex('#4f4a42') }));

  // Underwater massage bath with its control panel.
  f.box([0.2, 0, -7.6], [2.5, 0.78, -6.3], (p, n, face) => {
    if (face === 'top') {
      const inner = p[0] > 0.32 && p[0] < 2.38 && p[2] > -7.48 && p[2] < -6.42;
      if (inner)
        return { albedo: mix(hex('#222a32'), hex('#4a5860'), vnoise(p[0] * 6, p[2] * 6, 37)) };
    }
    const rim = p[1] > 0.7 ? 1.1 : 1;
    return { albedo: mul(hex('#c9d0c8'), rim) };
  });
  f.box([0.5, 1.1, BACK + 0.02], [1.0, 1.8, BACK + 0.1], (p, n, face) => {
    const gauge = face === 'front' && Math.hypot(p[0] - 0.75, p[1] - 1.55) < 0.12;
    return { albedo: gauge ? hex('#ece7da') : hex('#4a5860') };
  });
  f.box([0.72, 0.78, BACK + 0.05], [0.78, 1.1, -7.2], () => ({ albedo: hex('#333e47') }));

  // Leather massage table by the back wall.
  f.box([-2.3, 0.65, -9.4], [-0.6, 0.8, -8.7], (p, n, face) => ({
    albedo: face === 'top' ? hex('#3b2819') : hex('#1e140e'),
  }));
  for (const lx of [-2.2, -0.7])
    f.box([lx - 0.03, 0, -9.3], [lx + 0.03, 0.65, -8.8], () => ({ albedo: hex('#151a20') }));

  // Nurse post in the left foreground: desk, ledger, lamp.
  f.box([-3.5, 0, -4.9], [-1.95, 0.78, -3.7], (p, n, face) => {
    if (face === 'top') return { albedo: hex('#8f6639') };
    const drawer = face === 'right' && p[1] > 0.45 && p[1] < 0.7 && Math.abs(p[2] + 4.3) < 0.35;
    return { albedo: drawer ? hex('#2a1d14') : hex('#5c4a38') };
  });
  f.box([-3.1, 0.78, -4.5], [-2.45, 0.82, -4.05], () => ({ albedo: hex('#ece7da') }));
  f.box([-3.05, 0.82, -4.45], [-2.5, 0.83, -4.1], (p) => ({
    albedo: ((p[2] * 60) | 0) % 2 ? hex('#93a19f') : hex('#ece7da'),
  }));
  f.cylinder([-3.3, -4.6], 0.025, 0.78, 1.2, () => ({ albedo: hex('#333e47') }));
  const lampOn = !dark;
  f.ellipsoid([-3.2, 1.22, -4.55], [0.15, 0.08, 0.12], (p, n) =>
    n[1] < -0.3 && lampOn
      ? { albedo: [0, 0, 0], emit: hex('#e3cb94') }
      : { albedo: hex('#4a5860') },
  );
  f.box([-3.4, 0, -3.6], [-3.0, 0.45, -3.2], () => ({ albedo: hex('#2a1d14') })); // stool

  // Fluorescent fixtures.
  const tubes = [
    { a: [-1.0, 3.1, -8.2], b: [1.0, 3.1, -8.2], on: !dark },
    { a: [-1.0, 3.1, -4.2], b: [1.0, 3.1, -4.2], on: lighting === 'bright' },
  ];
  for (const t of tubes) {
    f.box([t.a[0], 3.06, t.a[2] - 0.1], [t.b[0], 3.2, t.a[2] + 0.1], (p, n, face) =>
      face === 'bottom'
        ? { albedo: [0, 0, 0], emit: t.on ? mul(TUBE, 1.25) : hex('#333e47') }
        : { albedo: hex('#4a5860') },
    );
  }

  const lights = [];
  if (lighting === 'bright') {
    lights.push({
      type: 'tube',
      a: tubes[0].a,
      b: tubes[0].b,
      color: TUBE,
      intensity: 1.9,
      range: 9,
    });
    lights.push({
      type: 'tube',
      a: tubes[1].a,
      b: tubes[1].b,
      color: TUBE,
      intensity: 1.9,
      range: 9,
    });
    lights.push({
      type: 'point',
      pos: [3.3, 2.6, -5.5],
      color: [0.8, 0.86, 0.9],
      intensity: 0.9,
      range: 7,
      wrap: 0.4,
    });
  } else if (dim) {
    lights.push({
      type: 'tube',
      a: tubes[0].a,
      b: tubes[0].b,
      color: TUBE,
      intensity: 1.3,
      range: 7,
    });
  } else {
    lights.push({
      type: 'point',
      pos: [3.0, 2.5, -5.5],
      color: MOON,
      intensity: 1.2,
      range: 6.5,
      wrap: 0.3,
    });
    lights.push({
      type: 'point',
      pos: [1.25, 1.2, BACK + 0.4],
      color: [0.5, 0.58, 0.62],
      intensity: 0.5,
      range: 3,
    });
    lights.push({
      type: 'point',
      pos: [-3.3, 1.5, -7.8],
      color: LAMP,
      intensity: 1.3,
      range: 5.5,
      wrap: 0.4,
    });
  }
  if (lampOn)
    lights.push({
      type: 'point',
      pos: [-3.15, 1.1, -4.4],
      color: LAMP,
      intensity: dim ? 1.5 : 0.7,
      range: 3,
    });

  f.shade({
    lights,
    ambient: dark
      ? { sky: hex('#151a20'), ground: hex('#0a0c0f') }
      : dim
        ? { sky: hex('#222a32'), ground: hex('#151a20') }
        : { sky: hex('#6a7a7f'), ground: hex('#4a5860') },
    fog: {
      color: dark ? hex('#0a0c0f') : hex('#222a32'),
      near: 5,
      far: 14,
      max: dark ? 0.6 : 0.35,
    },
  });
  for (const t of tubes) if (t.on) f.halo(mix(t.a, t.b, 0.5), mul(TUBE, 0.18), 24);
  if (lampOn) f.halo([-3.2, 1.18, -4.55], mul(LAMP, 0.2), 10);
  if (dark) {
    f.halo([3.6, 2.6, -5.5], mul(MOON, 0.12), 22);
    f.halo([X0, 1.5, -7.8], mul(LAMP, 0.16), 12);
  }
  return f.finish({ vignette: dark ? 0.6 : dim ? 0.5 : 0.35, seed: 202 });
}
