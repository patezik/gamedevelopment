// Tiny deterministic G-buffer rasteriser for the reference prototypes (art-direction.md §8).
// Not a game renderer: it paints simple world-space geometry (planes, boxes, cylinders,
// ellipsoids) in painter's order, lights it once and hands the colour to the HS-16 quantiser.
// No randomness except the hashed value noise below, so every run is byte-identical.

export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const smooth = (e0, e1, v) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Integer hash → [0, 1). */
export function hash(x, y, seed = 0) {
  let h =
    (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm(x, y, seed = 0, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x, y, seed + o * 17) * amp;
    total += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / total;
}

export class Frame {
  /**
   * Camera at (0, eye, 0) looking down −Z. `horizon` is the screen y of the eye level, `focal`
   * the focal length in pixels. Screen x of the optical axis is width / 2 unless `cx` is given.
   */
  constructor(
    width,
    height,
    { eye = 1.6, horizon = height / 2, focal = width * 0.75, cx = width / 2 } = {},
  ) {
    Object.assign(this, { width, height, eye, horizon, focal, cx });
    const n = width * height;
    this.albedo = new Float32Array(n * 3);
    this.emit = new Float32Array(n * 3);
    this.pos = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    this.lit = new Uint8Array(n); // 1: lit surface, 0: emissive only
    this.accent = new Uint8Array(n); // 1: may use the reserved accent colour (§3)
    this.origin = [0, eye, 0];
  }

  project([x, y, z]) {
    const d = -z;
    return [this.cx + (this.focal * x) / d, this.horizon - (this.focal * (y - this.eye)) / d];
  }

  ray(sx, sy) {
    return norm([(sx - this.cx) / this.focal, -(sy - this.horizon) / this.focal, -1]);
  }

  put(i, albedo, pos, normal, emit = null, accent = false) {
    this.accent[i] = accent ? 1 : 0;
    this.albedo.set(albedo, i * 3);
    this.pos.set(pos, i * 3);
    this.nrm.set(normal, i * 3);
    if (emit) this.emit.set(emit, i * 3);
    else this.emit.fill(0, i * 3, i * 3 + 3);
    this.lit[i] = 1;
  }

  glowPixel(i, color) {
    this.emit.set(color, i * 3);
    this.albedo.fill(0, i * 3, i * 3 + 3);
    this.lit[i] = 0;
    this.accent[i] = 0;
  }

  /** Scanline fill of a screen polygon; calls fn(x, y, index) at covered pixel centres. */
  polygon(points, fn) {
    const ys = points.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let k = 0; k < points.length; k++) {
        const [ax, ay] = points[k];
        const [bx, by] = points[(k + 1) % points.length];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy))
          xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(this.width - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = xa; x <= xb; x++) fn(x, y, y * this.width + x);
      }
    }
  }

  /**
   * World quad on its plane. `corners` are four coplanar world points; `material(p, n)` returns
   * { albedo, emit? } or null to leave the pixel alone. Pixels behind the camera are skipped.
   */
  quad(corners, material) {
    const n = norm(
      (() => {
        const u = sub(corners[1], corners[0]);
        const v = sub(corners[3], corners[0]);
        return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      })(),
    );
    const facing = dot(n, sub(this.origin, corners[0])) >= 0 ? n : mul(n, -1);
    const d = dot(facing, corners[0]);
    const clipped = corners.map((c) => [c[0], c[1], Math.min(c[2], -0.05)]);
    this.polygon(
      clipped.map((c) => this.project(c)),
      (x, y, i) => {
        const r = this.ray(x + 0.5, y + 0.5);
        const denom = dot(facing, r);
        if (Math.abs(denom) < 1e-6) return;
        const t = (d - dot(facing, this.origin)) / denom;
        if (t <= 0) return;
        const p = [this.origin[0] + r[0] * t, this.origin[1] + r[1] * t, this.origin[2] + r[2] * t];
        const m = material(p, facing);
        if (m) this.put(i, m.albedo, p, m.normal ?? facing, m.emit, m.accent);
      },
    );
  }

  /** Axis-aligned box; `material(p, n, face)` per visible face ('front', 'top', 'left', …). */
  box([x0, y0, z0], [x1, y1, z1], material) {
    const faces = {
      back: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      front: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      bottom: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      top: [
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      left: [
        [x0, y0, z0],
        [x0, y1, z0],
        [x0, y1, z1],
        [x0, y0, z1],
      ],
      right: [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
    };
    const normals = {
      back: [0, 0, -1],
      front: [0, 0, 1],
      bottom: [0, -1, 0],
      top: [0, 1, 0],
      left: [-1, 0, 0],
      right: [1, 0, 0],
    };
    // Far faces first so that near faces of the same box win.
    const order = Object.keys(faces)
      .filter((f) => dot(normals[f], sub(this.origin, faces[f][0])) > 0)
      .sort((a, b) => {
        const ca = faces[a].reduce((s, c) => s + c[2], 0);
        const cb = faces[b].reduce((s, c) => s + c[2], 0);
        return ca - cb;
      });
    for (const f of order) this.quad(faces[f], (p, n) => material(p, n, f));
  }

  /** Vertical cylinder (axis along Y) from y0 to y1. */
  cylinder([cx, cz], radius, y0, y1, material) {
    const top = this.project([cx, y1, cz]);
    const bottom = this.project([cx, y0, cz]);
    const w = (this.focal * radius) / -cz + 2;
    const minY = Math.max(0, Math.floor(Math.min(top[1], bottom[1]) - w));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(top[1], bottom[1]) + w));
    const minX = Math.max(0, Math.floor(Math.min(top[0], bottom[0]) - w));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(top[0], bottom[0]) + w));
    const o = this.origin;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const r = this.ray(x + 0.5, y + 0.5);
        const ox = o[0] - cx;
        const oz = o[2] - cz;
        const a = r[0] * r[0] + r[2] * r[2];
        const b = 2 * (ox * r[0] + oz * r[2]);
        const c = ox * ox + oz * oz - radius * radius;
        const disc = b * b - 4 * a * c;
        if (disc < 0 || a < 1e-9) continue;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t <= 0) continue;
        const p = [o[0] + r[0] * t, o[1] + r[1] * t, o[2] + r[2] * t];
        if (p[1] < y0 || p[1] > y1) continue;
        const n = norm([p[0] - cx, 0, p[2] - cz]);
        const m = material(p, n);
        if (m) this.put(y * this.width + x, m.albedo, p, m.normal ?? n, m.emit, m.accent);
      }
    }
  }

  /** Ellipsoid; material gets the unit-sphere coordinates `u` as well. */
  ellipsoid(center, radii, material) {
    const corners = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          corners.push(
            this.project([
              center[0] + sx * radii[0],
              center[1] + sy * radii[1],
              Math.min(-0.05, center[2] + sz * radii[2]),
            ]),
          );
        }
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    const o = this.origin;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const r = this.ray(x + 0.5, y + 0.5);
        const oc = [
          (o[0] - center[0]) / radii[0],
          (o[1] - center[1]) / radii[1],
          (o[2] - center[2]) / radii[2],
        ];
        const rd = [r[0] / radii[0], r[1] / radii[1], r[2] / radii[2]];
        const a = dot(rd, rd);
        const b = 2 * dot(oc, rd);
        const c = dot(oc, oc) - 1;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t <= 0) continue;
        const u = [oc[0] + rd[0] * t, oc[1] + rd[1] * t, oc[2] + rd[2] * t];
        const p = [
          center[0] + u[0] * radii[0],
          center[1] + u[1] * radii[1],
          center[2] + u[2] * radii[2],
        ];
        const n = norm([u[0] / radii[0], u[1] / radii[1], u[2] / radii[2]]);
        const m = material(p, n, u);
        if (m) this.put(y * this.width + x, m.albedo, p, m.normal ?? n, m.emit, m.accent);
      }
    }
  }

  /**
   * Lights the G-buffer. `lights`: { type: 'point', pos } or { type: 'tube', a, b } with
   * color, intensity, range and optional `wrap` (0–1, softens the terminator). `ambient`:
   * { sky, ground } hemisphere colours. `fog`: { color, near, far, max }.
   */
  shade({ lights = [], ambient = { sky: [0, 0, 0], ground: [0, 0, 0] }, fog = null }) {
    const n = this.width * this.height;
    const out = new Float32Array(n * 3);
    const samples = lights.flatMap((l) => {
      if (l.type !== 'tube') return [{ ...l, weight: 1 }];
      const count = l.samples ?? 6;
      return Array.from({ length: count }, (_, k) => ({
        ...l,
        pos: mix(l.a, l.b, (k + 0.5) / count),
        weight: 1 / count,
      }));
    });
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      if (!this.lit[i]) {
        out.set(this.emit.subarray(j, j + 3), j);
        continue;
      }
      const p = [this.pos[j], this.pos[j + 1], this.pos[j + 2]];
      const nn = [this.nrm[j], this.nrm[j + 1], this.nrm[j + 2]];
      const up = nn[1] * 0.5 + 0.5;
      const light = mix(ambient.ground, ambient.sky, up);
      for (const s of samples) {
        const L = sub(s.pos, p);
        const dist = Math.hypot(L[0], L[1], L[2]);
        if (dist > s.range) continue;
        const wrap = s.wrap ?? 0.15;
        const lambert = Math.max(0, (dot(nn, mul(L, 1 / dist)) + wrap) / (1 + wrap));
        const fall = (1 - dist / s.range) ** 2;
        const k = s.intensity * s.weight * lambert * fall;
        light[0] += s.color[0] * k;
        light[1] += s.color[1] * k;
        light[2] += s.color[2] * k;
      }
      let col = [
        this.albedo[j] * light[0] + this.emit[j],
        this.albedo[j + 1] * light[1] + this.emit[j + 1],
        this.albedo[j + 2] * light[2] + this.emit[j + 2],
      ];
      if (fog) {
        const dist = Math.hypot(
          p[0] - this.origin[0],
          p[1] - this.origin[1],
          p[2] - this.origin[2],
        );
        col = mix(col, fog.color, smooth(fog.near, fog.far, dist) * (fog.max ?? 1));
      }
      out.set(col, j);
    }
    this.color = out;
    return this;
  }

  /** Additive screen-space halo around a world point or tube (no geometry change). */
  halo(worldPos, color, radiusPx, strength = 1) {
    const [hx, hy] = this.project(worldPos);
    const r2 = radiusPx * radiusPx;
    for (
      let y = Math.max(0, Math.floor(hy - radiusPx * 2));
      y < Math.min(this.height, hy + radiusPx * 2);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(hx - radiusPx * 2));
        x < Math.min(this.width, hx + radiusPx * 2);
        x++
      ) {
        const d2 = (x + 0.5 - hx) ** 2 + (y + 0.5 - hy) ** 2;
        const k = strength * Math.exp(-d2 / r2);
        const j = (y * this.width + x) * 3;
        for (let c = 0; c < 3; c++) this.color[j + c] += color[c] * k;
      }
    }
  }

  /** Post pass over final colour: fn(x, y, [r, g, b]) → [r, g, b]. */
  post(fn) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const j = (y * this.width + x) * 3;
        this.color.set(fn(x, y, [this.color[j], this.color[j + 1], this.color[j + 2]]), j);
      }
    }
  }

  /** Vignette and fine grain shared by every plate (§4: "аналоговая" texture). */
  finish({ vignette = 0.35, grain = 0.02, seed = 1 } = {}) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    this.post((x, y, c) => {
      const r = ((x + 0.5 - cx) / cx) ** 2 * 0.6 + ((y + 0.5 - cy) / cy) ** 2 * 0.4;
      const k = 1 - vignette * r;
      const g = (hash(x, y, seed) - 0.5) * grain;
      return [c[0] * k + g, c[1] * k + g, c[2] * k + g];
    });
    return this;
  }
}
