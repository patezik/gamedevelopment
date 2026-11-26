import type { OsAppManifest } from '../../os/types';
import { MapsApp } from './App';

export const mapsManifest: OsAppManifest = {
  id: 'maps',
  title: 'Карты',
  icon: { glyph: '🗺' },
  component: MapsApp,
  order: 80,
};
