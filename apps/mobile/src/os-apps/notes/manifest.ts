import type { OsAppManifest } from '../../os/types';
import { NotesApp } from './App';

export const notesManifest: OsAppManifest = {
  id: 'notes',
  title: 'Заметки',
  icon: { glyph: '📝' },
  component: NotesApp,
  order: 70,
};
