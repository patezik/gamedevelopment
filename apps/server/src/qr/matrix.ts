import QRCode from 'qrcode';

/** What Godot draws from (ADR 0010): `modules` is `size * size` characters of `0`/`1`, row by row. */
export interface QrMatrix {
  readonly size: number;
  readonly modules: string;
}

/** Renders `text` as a QR matrix with error correction level M. */
export function renderMatrix(text: string): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return {
    size: modules.size,
    modules: Array.from(modules.data, (dark) => (dark ? '1' : '0')).join(''),
  };
}
