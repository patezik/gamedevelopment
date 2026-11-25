import type { OsAppManifest } from '../os/types';
import { browserManifest } from './browser/manifest';
import { callsManifest } from './calls/manifest';
import { cameraManifest } from './camera/manifest';
import { contactsManifest } from './contacts/manifest';
import { filesManifest } from './files/manifest';
import { galleryManifest } from './gallery/manifest';
import { mapsManifest } from './maps/manifest';
import { messagesManifest } from './messages/manifest';
import { notesManifest } from './notes/manifest';
import { settingsManifest } from './settings/manifest';

/** The only place an app is registered: add its manifest to this list. */
export const OS_APPS: readonly OsAppManifest[] = [
  cameraManifest,
  contactsManifest,
  callsManifest,
  messagesManifest,
  galleryManifest,
  filesManifest,
  notesManifest,
  mapsManifest,
  browserManifest,
  settingsManifest,
].sort((a, b) => a.order - b.order);

export function findApp(id: string): OsAppManifest | undefined {
  return OS_APPS.find((app) => app.id === id);
}
