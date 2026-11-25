import type { OsAppManifest } from '../../os/types';
import { ContactsApp } from './App';

export const contactsManifest: OsAppManifest = {
  id: 'contacts',
  title: 'Контакты',
  icon: { glyph: '👤' },
  component: ContactsApp,
  order: 20,
};
