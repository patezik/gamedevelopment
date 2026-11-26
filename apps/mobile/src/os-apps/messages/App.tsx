import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';
import { sendPhoneAction, sendPhoneUi } from '../../connection/gameConnection';
import type { OsAppProps } from '../../os/types';

type Thread = PhoneView['threads'][number];

export interface MessagesActions {
  /** Sends a template reply (`message` action). Returns false when offline. */
  reply: (contactId: string, templateId: string) => boolean;
  /** `phone.ui`: purely informational for the server. */
  ui: (kind: 'appOpened' | 'notificationRead', ref: string) => void;
}

const liveActions: MessagesActions = {
  reply: (contactId, templateId) => sendPhoneAction({ type: 'message', contactId, templateId }),
  ui: (kind, ref) => {
    sendPhoneUi(kind, ref);
  },
};

/** Game minutes since the start to a day clock. */
export function clock(minutes: number): string {
  const m = minutes % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function lastActivity(thread: Thread): number {
  return thread.messages.reduce((max, m) => Math.max(max, m.at), 0);
}

/**
 * Every thread is drawn the same way, whoever the sender is: an unknown number or a sender that
 * is not in the contacts looks like any other conversation (§3.1 of AGENTS.md).
 */
function title(view: PhoneView, thread: Thread): string {
  const contact = view.contacts.find((c) => c.id === thread.contactId);
  return contact?.name ?? thread.contactId;
}

export function MessagesApp({
  view,
  actions = liveActions,
}: OsAppProps & { actions?: MessagesActions }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    actions.ui('appOpened', 'messages');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thread = view.threads.find((t) => t.id === openId);

  const open = (t: Thread) => {
    setOpenId(t.id);
    setOffline(false);
    if (t.unread > 0) {
      for (const n of view.notifications) {
        if (n.appId === 'messages' && !n.read) {
          actions.ui('notificationRead', n.id);
        }
      }
    }
  };

  if (thread) {
    return (
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="К списку переписок"
          onPress={() => setOpenId(null)}
          style={styles.back}
        >
          <Text style={styles.backText}>‹ {title(view, thread)}</Text>
        </Pressable>
        <ScrollView style={styles.flex} contentContainerStyle={styles.messages}>
          {thread.messages.map((m) => (
            <View key={m.id} style={[styles.bubble, m.from === 'me' ? styles.mine : styles.theirs]}>
              <Text style={styles.bubbleText}>{m.text}</Text>
              <Text style={styles.time}>{clock(m.at)}</Text>
            </View>
          ))}
          {thread.typing ? <Text style={styles.typing}>печатает…</Text> : null}
        </ScrollView>
        {offline ? <Text style={styles.offline}>Нет связи, ответ не отправлен</Text> : null}
        <View style={styles.replies}>
          {thread.availableReplies.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              onPress={() => setOffline(!actions.reply(thread.contactId, r.id))}
              style={styles.reply}
            >
              <Text style={styles.replyText}>{r.text}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  const threads = [...view.threads].sort((a, b) => lastActivity(b) - lastActivity(a));
  if (threads.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Нет переписок</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.root}>
      {threads.map((t) => {
        const lastMessage = t.messages[t.messages.length - 1];
        return (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            accessibilityLabel={t.unread > 0 ? `${title(view, t)}, ${t.unread}` : title(view, t)}
            onPress={() => open(t)}
            style={styles.row}
          >
            <View style={styles.flex}>
              <Text style={styles.name}>{title(view, t)}</Text>
              <Text numberOfLines={1} style={styles.preview}>
                {t.typing ? 'печатает…' : (lastMessage?.text ?? '')}
              </Text>
            </View>
            {t.unread > 0 ? <Text style={styles.badge}>{t.unread}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: '#b4c2ba', fontSize: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  name: { color: '#f0eee5', fontSize: 16, fontWeight: '700' },
  preview: { color: '#b4c2ba', fontSize: 14, marginTop: 2 },
  badge: {
    color: '#131717',
    backgroundColor: '#d9a441',
    borderRadius: 10,
    minWidth: 20,
    textAlign: 'center',
    paddingHorizontal: 6,
    fontWeight: '700',
  },
  back: { paddingHorizontal: 16, paddingVertical: 8 },
  backText: { color: '#d9a441', fontSize: 16 },
  messages: { padding: 12, gap: 8 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#2f5a46' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#2a3430' },
  bubbleText: { color: '#f0eee5', fontSize: 15 },
  time: { color: '#b4c2ba', fontSize: 11, marginTop: 4, alignSelf: 'flex-end' },
  typing: { color: '#b4c2ba', fontStyle: 'italic' },
  offline: { color: '#d97a6c', paddingHorizontal: 16 },
  replies: { padding: 12, gap: 8 },
  reply: { padding: 12, borderRadius: 10, backgroundColor: '#1d2422' },
  replyText: { color: '#f0eee5', fontSize: 15 },
});
