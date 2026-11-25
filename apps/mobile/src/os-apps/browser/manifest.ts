import type { OsAppManifest } from '../../os/types';
import { BrowserApp } from './App';

export const browserManifest: OsAppManifest = {
  id: 'browser',
  title: 'Браузер',
  icon: { glyph: '🌐' },
  component: BrowserApp,
  order: 90,
};
