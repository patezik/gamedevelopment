import type { OsAppManifest } from '../../os/types';
import { SettingsApp } from './App';

export const settingsManifest: OsAppManifest = {
  id: 'settings',
  title: 'Настройки',
  icon: { glyph: '⚙' },
  component: SettingsApp,
  order: 100,
};
