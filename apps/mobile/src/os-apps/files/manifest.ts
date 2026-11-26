import type { OsAppManifest } from '../../os/types';
import { FilesApp } from './App';

export const filesManifest: OsAppManifest = {
  id: 'files',
  title: 'Файлы',
  icon: { glyph: '📁' },
  component: FilesApp,
  order: 60,
};
