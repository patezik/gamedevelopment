// ui/frames/photo_frame: 9-slice paper border of a dossier photograph with black photo-mount
// corners (art-direction.md §6). 24×24, patch margins 6 px; the centre is transparent.
// Returns palette indices, −1 for transparent pixels.

import { hash } from '../raster.mjs';

export const SIZE = [24, 24];
export const MARGIN = 6;
const C0 = 0;
const C1 = 1;
const C4 = 4;
const C7 = 7;
const A1 = 15;

export function paint() {
  const [w, h] = SIZE;
  const out = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      let index = -1;
      if (edge === 0) index = C1;
      else if (edge < MARGIN - 1) index = hash(x, y, 7) > 0.85 ? C7 : A1;
      else if (edge === MARGIN - 1) index = C4;
      const cx = Math.min(x, w - 1 - x);
      const cy = Math.min(y, h - 1 - y);
      if (cx + cy <= MARGIN && cx < MARGIN && cy < MARGIN) index = cx + cy === MARGIN ? C1 : C0;
      out[y * w + x] = index;
    }
  }
  return out;
}
