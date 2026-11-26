export declare const DEFAULT_ART_ROOT: string;
export declare const DEFAULT_CONTENT_ROOT: string;
export declare function checkArt(options?: { artRoot?: string; contentRoot?: string }): {
  errors: string[];
  checked: number;
};
