// Portrait rig (art-direction.md §6): a frontal "personnel file" photograph, 96×128, the same
// backdrop, framing and light for every character, neutral expression. Nothing in a portrait
// may hint at guilt: the same rig is used for whoever the generator makes culprit.

import { Frame, fbm, hex, mix, mul, smooth } from '../raster.mjs';

export const SIZE = [96, 128];
// Faces read better with fewer distant colour pairs: less salt-and-pepper on skin (§4).
export const QUANTIZE = { pairPenalty: 0.9 };
const Z = -2.95;
const KEY = [0.86, 0.92, 0.9];
const FILL = [0.95, 0.86, 0.76];

function ellipseIn(x, y, cx, cy, rx, ry) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
}

/** Facial features on the unit sphere of the head (u: x right, y up, z towards camera). */
function face(u, look) {
  const [x, y, z] = u;
  let albedo = look.skin;
  if (z < 0.2) return { albedo };
  for (const side of [-1, 1]) {
    const ex = side * 0.37;
    const socket = ellipseIn(x, y, ex, 0.06, 0.26, 0.15);
    if (socket < 1) albedo = mul(albedo, 0.78 + socket * 0.2);
    const eye = ellipseIn(x, y, ex, 0.05, 0.13, 0.055);
    if (eye < 1)
      albedo = Math.abs(x - ex) < 0.045 ? hex('#151a20') : mix(hex('#93a19f'), albedo, 0.35);
    if (eye >= 1 && ellipseIn(x, y, ex, 0.075, 0.14, 0.06) < 1 && y > 0.07)
      albedo = mul(albedo, 0.6); // upper lid
    const brow =
      Math.abs(y - (0.21 + 0.03 * (1 - Math.abs(x - ex) / 0.22))) < 0.035 && Math.abs(x - ex) < 0.2;
    if (brow) albedo = look.brow;
    if (look.glasses) {
      // Thin rectangular frames: rims of constant width in sphere units.
      const dx = Math.abs(x - ex);
      const dy = Math.abs(y - 0.06);
      const sideRim = dx > 0.2 && dx < 0.245 && dy < 0.15;
      const topRim = dy > 0.11 && dy < 0.15 && dx < 0.245 && y > 0.06;
      if (sideRim || topRim) albedo = hex('#151a20');
    }
  }
  if (look.glasses && Math.abs(y - 0.12) < 0.03 && Math.abs(x) < 0.13) albedo = hex('#151a20');
  // Nose: shadow on the side away from the key light, nostrils, philtrum.
  if (x > 0.02 && x < 0.1 && y < 0.0 && y > -0.28) albedo = mul(albedo, 0.8);
  if (ellipseIn(x, y, -0.07, -0.3, 0.04, 0.025) < 1 || ellipseIn(x, y, 0.07, -0.3, 0.04, 0.025) < 1)
    albedo = mul(albedo, 0.55);
  if (y < -0.3 && y > -0.36 && Math.abs(x) < 0.11) albedo = mul(albedo, 0.9);
  // Mouth: closed, neutral.
  if (Math.abs(y + 0.48) < 0.028 && Math.abs(x) < 0.22) albedo = mul(look.lip, 0.6);
  else if (y < -0.42 && y > -0.48 && Math.abs(x) < 0.2) albedo = mix(albedo, look.lip, 0.5);
  if (look.stubble && y < -0.25 && Math.abs(x) < 0.75) albedo = mul(albedo, 0.86);
  return { albedo };
}

function rig(look) {
  const [w, h] = SIZE;
  const f = new Frame(w, h, { eye: 1.6, horizon: 50, focal: 600 });
  // Backdrop: the same flat grey-blue wall for every portrait, lighter behind the head.
  f.polygon(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    (x, y, i) => {
      const r = Math.hypot((x - w * 0.3) / w, (y - h * 0.3) / h);
      f.glowPixel(i, mix(hex('#5a6a70'), hex('#2c363e'), smooth(0.05, 0.95, r)));
    },
  );

  const head = [0, 1.62, Z];
  // Neck first, then torso and clothing over it (painter's order).
  f.cylinder([0, Z], 0.056, 1.3, 1.56, () => ({ albedo: mul(look.skin, 0.82) }));
  f.ellipsoid([0, 1.1, Z - 0.06], [0.31, 0.34, 0.16], (p, n, u) => look.torso(u));
  if (look.collar) look.collar(f);
  // Ears, head, hair.
  const radii = look.head ?? [0.093, 0.122, 0.105];
  for (const side of [-1, 1]) {
    f.ellipsoid([side * (radii[0] - 0.002), 1.6, Z], [0.016, 0.036, 0.024], () => ({
      albedo: mul(look.skin, 0.9),
    }));
  }
  f.ellipsoid(head, radii, (p, n, u) => face(u, look));
  f.ellipsoid([0, 1.645, Z - 0.012], [0.1, 0.118, 0.112], (p, n, u) => look.hair(u, n));
  if (look.extra) look.extra(f);

  f.shade({
    lights: [
      { type: 'point', pos: [-1.3, 2.5, -1.4], color: KEY, intensity: 2.3, range: 6, wrap: 0.2 },
      { type: 'point', pos: [1.4, 1.7, -2.0], color: FILL, intensity: 0.55, range: 5, wrap: 0.4 },
      { type: 'point', pos: [0.7, 2.2, -4.2], color: KEY, intensity: 0.9, range: 2.2, wrap: 0 },
      { type: 'point', pos: [0, 1.2, -0.8], color: FILL, intensity: 0.7, range: 4, wrap: 0.5 },
    ],
    // Warm bounce from below keeps shadowed skin on the warm ramp instead of cold grey,
    // which would read as stubble at 96×128 (§6.2).
    ambient: { sky: hex('#3a4148'), ground: hex('#5e4434') },
  });
  return f.finish({ vignette: 0.3, grain: 0.015, seed: look.seed });
}

/** Главный врач, вариант m1: седеющий мужчина в очках, белый халат, рубашка с галстуком. */
export function headDoctorM1() {
  const grey = hex('#8d8f88');
  return rig({
    seed: 401,
    skin: hex('#9c8678'),
    brow: hex('#5a5a55'),
    lip: hex('#8a5a48'),
    glasses: true,
    hair(u) {
      const hairline = u[2] > 0.25 ? 0.62 - Math.abs(u[0]) * 0.25 : u[2] > -0.2 ? 0.1 : -0.35;
      if (u[1] < hairline) return null;
      if (u[2] > 0.25 && Math.abs(u[0]) < 0.35 && u[1] < 0.8) return null; // receding temples
      return { albedo: mul(grey, 0.8 + fbm(u[0] * 9, u[1] * 9, 7) * 0.35) };
    },
    torso(u) {
      const x = u[0];
      const y = u[1];
      const open = 0.34 * smooth(-0.5, 0.75, y);
      if (Math.abs(x) < open && u[2] > 0.3) {
        if (Math.abs(x) < 0.07 && y < 0.72) return { albedo: hex('#2c3a44') }; // tie
        return { albedo: hex('#b8c3c6') }; // shirt
      }
      const lapel = Math.abs(Math.abs(x) - open) < 0.035 && u[2] > 0.3;
      return { albedo: mul(hex('#d4d8d0'), lapel ? 0.7 : 1) };
    },
    collar(f) {
      // Shirt collar around the base of the neck.
      f.cylinder([0, Z], 0.062, 1.4, 1.47, (p, n) =>
        n[2] > -0.2 ? { albedo: hex('#c4ccd0') } : null,
      );
    },
    extra(f) {
      // Pen in the breast pocket.
      f.box([0.11, 1.02, Z + 0.1], [0.125, 1.12, Z + 0.12], () => ({ albedo: hex('#151a20') }));
    },
  });
}

/** Медсестра, вариант f1: тёмные волосы собраны, медицинская шапочка, форма с V-вырезом. */
export function nurseF1() {
  const hair = hex('#3b2819');
  return rig({
    seed: 402,
    head: [0.087, 0.118, 0.1],
    skin: hex('#a68c7e'),
    brow: hex('#2a1d14'),
    lip: hex('#a0605a'),
    glasses: false,
    hair(u) {
      // Pulled back: a soft hairline on the forehead, sides tucked above the ears.
      if (u[2] > 0.2 && u[1] < 0.48 - Math.abs(u[0]) * 0.12) return null;
      if (u[1] < 0.12 && u[2] > -0.3) return null;
      if (u[1] < -0.3) return null;
      const part = Math.abs(u[0]) < 0.03 && u[2] > 0.4 ? 0.6 : 1;
      const strands = 0.8 + fbm(u[0] * 14, u[1] * 4, 9) * 0.4;
      return { albedo: mul(hair, part * strands) };
    },
    torso(u) {
      const x = u[0];
      const y = u[1];
      const neck = 0.22 * smooth(0.2, 0.85, y);
      if (Math.abs(x) < neck && u[2] > 0.3) return { albedo: mul(hex('#a68c7e'), 0.85) };
      const seam = Math.abs(Math.abs(x) - neck) < 0.03 && u[2] > 0.3;
      return { albedo: mul(hex('#93a8a8'), seam ? 0.75 : 1) };
    },
    extra(f) {
      // Medical cap.
      f.ellipsoid([0, 1.745, Z - 0.01], [0.098, 0.04, 0.1], (p, n) =>
        n[1] > -0.4 ? { albedo: mul(hex('#dfe3dc'), p[1] > 1.73 ? 1 : 0.85) } : null,
      );
      // Name badge.
      f.box([-0.17, 1.12, Z + 0.1], [-0.07, 1.16, Z + 0.12], () => ({ albedo: hex('#ece7da') }));
    },
  });
}
