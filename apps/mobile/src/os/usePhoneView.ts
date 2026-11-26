import type { PhoneView } from '@hs/protocol';
import { usePhoneStore } from '../stores/phoneStore';
import { DEMO_PHONE_VIEW } from './demoPhoneView';

/** The live phone from the server; the demo fixture only while no session has delivered one (preview). */
export function usePhoneView(): PhoneView {
  return usePhoneStore((s) => s.view) ?? DEMO_PHONE_VIEW;
}
