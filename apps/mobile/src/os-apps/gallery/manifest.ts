import type { OsAppManifest } from '../../os/types';
import { GalleryApp } from './App';

export const galleryManifest: OsAppManifest = {
  id: 'gallery',
  title: 'Галерея',
  icon: { glyph: '🖼' },
  component: GalleryApp,
  order: 50,
};
