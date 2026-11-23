export {
  FakeClient,
  type ChaosOptions,
  type FakeClientOptions,
  type Role,
  type ServerMessageOf,
  type View,
} from './client.ts';
export { FakeDesktop, FakePhone, type PairOptions } from './roles.ts';
export {
  FakeClientHttpError,
  createPairingCode,
  fetchEvidenceQr,
  pairPhone,
  revokePhone,
  type PairingCode,
  type QrMatrix,
} from './rest.ts';
export { runCommand, type ReplContext } from './repl.ts';
