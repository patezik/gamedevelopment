import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';
import { playSound, vibrate } from './feedback';

type Notification = PhoneView['notifications'][number];

/** Notifications that are in `next` but not in `seen`. */
export function newNotifications(
  seen: ReadonlySet<string>,
  next: PhoneView['notifications'],
): PhoneView['notifications'] {
  return next.filter((n) => !seen.has(n.id));
}

export interface NotificationCenterProps {
  view: PhoneView;
  /** Opens the app a notification belongs to. */
  onOpenApp?: (appId: string) => void;
  /** Call actions are sent by the owner of the connection (MOB-006). */
  onAnswerCall?: (callId: string) => void;
  onDeclineCall?: (callId: string) => void;
  toastMs?: number;
}

/**
 * Toast for a new notification, a bell with the unread badge, the notification list and the
 * incoming-call overlay. All data comes from `PhoneView`: the server's `event` messages are
 * followed by a `view.update`, so the view is the single source.
 */
export function NotificationCenter({
  view,
  onOpenApp,
  onAnswerCall,
  onDeclineCall,
  toastMs = 4000,
}: NotificationCenterProps) {
  const seen = useRef<Set<string> | null>(null);
  const [toast, setToast] = useState<Notification | null>(null);
  const [open, setOpen] = useState(false);
  const ringingId = view.activeCall?.state === 'ringing' ? view.activeCall.callId : null;
  const rungId = useRef<string | null>(null);

  useEffect(() => {
    if (seen.current === null) {
      // Notifications present on first render are history, not news.
      seen.current = new Set(view.notifications.map((n) => n.id));
      return;
    }
    const fresh = newNotifications(seen.current, view.notifications);
    if (fresh.length === 0) {
      return;
    }
    fresh.forEach((n) => seen.current?.add(n.id));
    setToast(fresh[fresh.length - 1] ?? null);
    vibrate('notification');
    playSound();
  }, [view.notifications]);

  useEffect(() => {
    if (toast === null) {
      return;
    }
    const timer = setTimeout(() => setToast(null), toastMs);
    return () => clearTimeout(timer);
  }, [toast, toastMs]);

  useEffect(() => {
    if (ringingId !== null && ringingId !== rungId.current) {
      vibrate('call');
      playSound();
    }
    rungId.current = ringingId;
  }, [ringingId]);

  const unread = view.notifications.filter((n) => !n.read).length;
  const call = view.activeCall;

  return (
    <View pointerEvents="box-none" style={styles.layer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? `Уведомления, ${unread}` : 'Уведомления'}
        onPress={() => setOpen((v) => !v)}
        style={styles.bell}
      >
        <Text style={styles.bellText}>{unread > 0 ? `🔔 ${unread}` : '🔔'}</Text>
      </Pressable>

      {toast !== null && !open ? (
        <Pressable
          accessibilityRole="alert"
          onPress={() => {
            setToast(null);
            onOpenApp?.(toast.appId);
          }}
          style={styles.toast}
        >
          <Text style={styles.toastTitle}>{toast.title}</Text>
          <Text style={styles.toastText}>{toast.text}</Text>
        </Pressable>
      ) : null}

      {open ? (
        <View accessibilityLabel="Центр уведомлений" style={styles.panel}>
          {view.notifications.length === 0 ? (
            <Text style={styles.empty}>Нет уведомлений</Text>
          ) : (
            [...view.notifications]
              .sort((a, b) => b.at - a.at)
              .map((n) => (
                <Pressable
                  key={n.id}
                  accessibilityRole="button"
                  onPress={() => {
                    setOpen(false);
                    onOpenApp?.(n.appId);
                  }}
                  style={styles.row}
                >
                  <Text style={[styles.rowTitle, n.read ? styles.read : null]}>{n.title}</Text>
                  <Text style={styles.rowText}>{n.text}</Text>
                </Pressable>
              ))
          )}
        </View>
      ) : null}

      {call?.state === 'ringing' ? (
        <View accessibilityViewIsModal accessibilityLabel="Входящий звонок" style={styles.call}>
          <Text style={styles.callTitle}>Входящий звонок</Text>
          <Text style={styles.callWho}>
            {view.contacts.find((c) => c.id === call.contactId)?.name ?? call.contactId}
          </Text>
          <View style={styles.callButtons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Отклонить"
              onPress={() => onDeclineCall?.(call.callId)}
              style={[styles.callBtn, styles.decline]}
            >
              <Text style={styles.callBtnText}>Отклонить</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ответить"
              onPress={() => onAnswerCall?.(call.callId)}
              style={[styles.callBtn, styles.accept]}
            >
              <Text style={styles.callBtnText}>Ответить</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  bell: { position: 'absolute', top: 4, right: 96, padding: 6 },
  bellText: { color: '#f0eee5', fontSize: 14 },
  toast: {
    position: 'absolute',
    top: 40,
    left: 12,
    right: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#2a3430',
  },
  toastTitle: { color: '#f0eee5', fontSize: 15, fontWeight: '700' },
  toastText: { color: '#b4c2ba', fontSize: 14, marginTop: 2 },
  panel: {
    position: 'absolute',
    top: 40,
    left: 12,
    right: 12,
    padding: 8,
    borderRadius: 10,
    backgroundColor: '#1d2422',
  },
  empty: { color: '#b4c2ba', padding: 8 },
  row: { padding: 8 },
  rowTitle: { color: '#f0eee5', fontSize: 15, fontWeight: '700' },
  read: { fontWeight: '400' },
  rowText: { color: '#b4c2ba', fontSize: 14 },
  call: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#131717f2',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  callTitle: { color: '#b4c2ba', fontSize: 16 },
  callWho: { color: '#f0eee5', fontSize: 28, fontWeight: '700' },
  callButtons: { flexDirection: 'row', gap: 16, marginTop: 24 },
  callBtn: { paddingHorizontal: 20, paddingVertical: 14, borderRadius: 28 },
  decline: { backgroundColor: '#8a2f2f' },
  accept: { backgroundColor: '#2f7a4a' },
  callBtnText: { color: '#f0eee5', fontSize: 16, fontWeight: '700' },
});
