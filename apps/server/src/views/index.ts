import type { ClientEvent, PhoneView, PlayerView } from '@hs/protocol';
import type { Session, SessionRole } from '../sessions/index.ts';

export type RoleView = PlayerView | PhoneView;

/** Builds the role's projection; `undefined` means the session has nothing to show yet. */
export type ViewSource = (session: Session, role: SessionRole) => RoleView | undefined;

/** Role-filtered client events for one dispatch (the engine's raw events never reach a client). */
export type EventSource = (
  session: Session,
  role: SessionRole,
  result: { readonly events: readonly unknown[]; readonly outcome?: string },
) => readonly ClientEvent[];

export const ROLES: readonly SessionRole[] = ['desktop', 'phone'];

/**
 * Last projected view per session and role. A view is reused while `session.stateVersion` is
 * unchanged, so a resync or a second reconnect does not run the projection again.
 */
export class ViewCache {
  readonly #entries = new WeakMap<Session, Map<SessionRole, { version: number; view: RoleView }>>();
  readonly #source: ViewSource;

  constructor(source: ViewSource) {
    this.#source = source;
  }

  get(session: Session, role: SessionRole): RoleView | undefined {
    const version = session.stateVersion;
    const cached = this.#entries.get(session)?.get(role);
    if (cached?.version === version) return cached.view;
    const view = this.#source(session, role);
    if (!view) return undefined;
    let roles = this.#entries.get(session);
    if (!roles) {
      roles = new Map<SessionRole, { version: number; view: RoleView }>();
      this.#entries.set(session, roles);
    }
    roles.set(role, { version, view });
    return view;
  }
}
