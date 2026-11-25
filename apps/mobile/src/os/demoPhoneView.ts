import { PhoneView } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.mid.json';

/** Fixture phone until the server connection and phoneStore exist; replace then. */
export const DEMO_PHONE_VIEW: PhoneView = PhoneView.parse(fixture);
