import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';
import { sendPhoneAction, sendPhoneUi } from '../../connection/gameConnection';
import type { OsAppProps } from '../../os/types';
import { useTextScale } from '../../stores/displayStore';

export interface ContactsActions {
  /** Sends a `call` action. Returns false when offline. */
  call: (contactId: string) => boolean;
  ui: (kind: 'appOpened', ref: string) => void;
}

const liveActions: ContactsActions = {
  call: (contactId) => sendPhoneAction({ type: 'call', contactId }),
  ui: (kind, ref) => {
    sendPhoneUi(kind, ref);
  },
};

export function ContactsApp({
  view,
  openApp,
  actions = liveActions,
}: OsAppProps & { actions?: ContactsActions }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const scale = useTextScale();

  useEffect(() => {
    actions.ui('appOpened', 'contacts');
  }, []);

  const contact: PhoneView['contacts'][number] | undefined = view.contacts.find(
    (c) => c.id === openId,
  );

  if (contact) {
    const busy = view.activeCall !== undefined;
    return (
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="К списку контактов"
          onPress={() => {
            setOpenId(null);
            setOffline(false);
          }}
          style={styles.back}
        >
          <Text style={[styles.backText, { fontSize: 16 * scale }]}>‹ Контакты</Text>
        </Pressable>
        <View style={styles.card}>
          <Text style={[styles.cardName, { fontSize: 24 * scale }]}>{contact.name}</Text>
          <Text style={[styles.number, { fontSize: 16 * scale }]}>{contact.number}</Text>
        </View>
        {offline ? <Text style={styles.offline}>Нет связи, звонок не отправлен</Text> : null}
        {busy ? <Text style={styles.hint}>Идёт другой звонок</Text> : null}
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Позвонить"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => {
              const sent = actions.call(contact.id);
              setOffline(!sent);
              if (sent) openApp?.('calls');
            }}
            style={[styles.btn, styles.callBtn, busy ? styles.disabled : null]}
          >
            <Text style={[styles.btnText, { fontSize: 16 * scale }]}>Позвонить</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Написать"
            onPress={() => openApp?.('messages')}
            style={[styles.btn, styles.msgBtn]}
          >
            <Text style={[styles.btnText, { fontSize: 16 * scale }]}>Написать</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (view.contacts.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Нет контактов</Text>
      </View>
    );
  }
  const contacts = [...view.contacts].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return (
    <ScrollView style={styles.root}>
      {contacts.map((c) => (
        <Pressable
          key={c.id}
          accessibilityRole="button"
          accessibilityLabel={c.name}
          onPress={() => setOpenId(c.id)}
          style={styles.row}
        >
          <Text style={[styles.name, { fontSize: 16 * scale }]}>{c.name}</Text>
          <Text style={[styles.number, { fontSize: 14 * scale }]}>{c.number}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: '#b4c2ba', fontSize: 16 },
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  name: { color: '#f0eee5', fontWeight: '700' },
  number: { color: '#b4c2ba', marginTop: 2 },
  back: { paddingHorizontal: 16, paddingVertical: 8 },
  backText: { color: '#d9a441' },
  card: { padding: 16, gap: 4 },
  cardName: { color: '#f0eee5', fontWeight: '700' },
  offline: { color: '#d97a6c', paddingHorizontal: 16 },
  hint: { color: '#b4c2ba', paddingHorizontal: 16 },
  buttons: { flexDirection: 'row', gap: 12, padding: 16 },
  btn: { paddingHorizontal: 20, paddingVertical: 14, borderRadius: 28 },
  callBtn: { backgroundColor: '#2f5a46' },
  msgBtn: { backgroundColor: '#1d2422' },
  disabled: { opacity: 0.4 },
  btnText: { color: '#f0eee5', fontWeight: '700' },
});
