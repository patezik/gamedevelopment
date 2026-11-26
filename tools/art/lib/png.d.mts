export declare function encodeIndexed(
  width: number,
  height: number,
  palette: ReadonlyArray<readonly [number, number, number]>,
  indices: Uint8Array,
): Buffer;
export declare function encodeRgba(width: number, height: number, rgba: Uint8Array): Buffer;
export declare function decode(buffer: Buffer): {
  width: number;
  height: number;
  colorType: number;
  rgba: Buffer;
};
