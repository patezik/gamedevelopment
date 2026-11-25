import type { OsAppManifest } from '../../os/types';
import { MessagesApp } from './App';

export const messagesManifest: OsAppManifest = {
  id: 'messages',
  title: 'Сообщения',
  icon: { glyph: '💬' },
  component: MessagesApp,
  order: 40,
};
