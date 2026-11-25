import type { OsAppManifest } from '../../os/types';
import { CallsApp } from './App';

export const callsManifest: OsAppManifest = {
  id: 'calls',
  title: 'Звонки',
  icon: { glyph: '📞' },
  component: CallsApp,
  order: 30,
};
