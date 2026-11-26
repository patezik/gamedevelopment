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

  /**
   * The view of `version` (default: current). A version the session has moved past yields
   * `undefined`, and a view computed while the state changed is not cached, so a half-updated
   * state never sits under a version.
   */
  get(session: Session, role: SessionRole, version = session.stateVersion): RoleView | undefined {
    if (version !== session.stateVersion) return undefined;
    const cached = this.#entries.get(session)?.get(role);
    if (cached?.version === version) return cached.view;
    const view = this.#source(session, role);
    if (!view || version !== session.stateVersion) return undefined;
    let roles = this.#entries.get(session);
    if (!roles) {
      roles = new Map<SessionRole, { version: number; view: RoleView }>();
      this.#entries.set(session, roles);
    }
    roles.set(role, { version, view });
    return view;
  }
}

/** Use only public engine projections, including when a session was restored from a save. */
export const engineView: ViewSource = (session, role) =>
  role === 'desktop' ? session.engine.playerView?.() : session.engine.phoneView?.();

/** Allowlist: raw domain payloads (including truth and hallucination markers) never go on the wire. */
export const engineEvents: EventSource = (session, role, result) => {
  if (role !== 'phone') return [];
  const view = session.engine.phoneView?.();
  if (!view) return [];
  const events: ClientEvent[] = [];
  for (const raw of result.events) {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) continue;
    if (raw.type === 'NotificationPosted' && 'notification' in raw) {
      const notification = raw.notification;
      if (!notification || typeof notification !== 'object' || !('id' in notification)) continue;
      const visible = view.notifications.find(({ id }) => id === notification.id);
      if (visible) events.push({ type: 'notification', notificationId: visible.id });
    } else if (raw.type === 'CallStarted' && 'call' in raw) {
      const call = raw.call;
      if (!call || typeof call !== 'object' || !('callId' in call)) continue;
      if (view.activeCall?.state === 'ringing' && view.activeCall.callId === call.callId) {
        events.push({ type: 'incomingCall', callId: view.activeCall.callId });
      }
    } else if (raw.type === 'EvidenceCaptured' && 'clueId' in raw) {
      const visible = session.engine
        .playerView?.()
        .caseBoard.clues.find(({ id, captured }) => id === raw.clueId && captured);
      if (visible) events.push({ type: 'scanResult', ok: true, clueRef: visible.id });
    }
  }
  return events;
};
