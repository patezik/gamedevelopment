import type { ComponentType } from 'react';
import type { PhoneView } from '@hs/protocol';

/** Icons are text glyphs: no image assets and no icon-font dependency. */
export interface IconRef {
  glyph: string;
}

export interface OsAppProps {
  view: PhoneView;
  /** Opens another phone app (set by the OS shell); apps do not import each other. */
  openApp?: (appId: string) => void;
}

export interface OsAppManifest {
  id: string;
  title: string;
  icon: IconRef;
  component: ComponentType<OsAppProps>;
  /** Overrides the badge the server sends in `PhoneView.apps`. */
  badge?: (view: PhoneView) => number;
  /** Narrows the server's `enabled` flag (it can only disable, never enable). */
  enabled?: (view: PhoneView) => boolean;
  order: number;
}
