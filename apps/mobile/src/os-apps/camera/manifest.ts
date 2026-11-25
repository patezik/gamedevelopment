import type { OsAppManifest } from '../../os/types';
import { CameraApp } from './App';

export const cameraManifest: OsAppManifest = {
  id: 'camera',
  title: 'Камера',
  icon: { glyph: '📷' },
  component: CameraApp,
  order: 10,
};
