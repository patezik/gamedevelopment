import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';
import { sendPhoneAction, sendPhoneUi } from '../../connection/gameConnection';
import { dayClock } from '../../os/caseTime';
import type { OsAppProps } from '../../os/types';
import { useTextScale } from '../../stores/displayStore';

type CallEntry = PhoneView['callLog'][number];

export interface CallsActions {
  /** Each returns false when offline. */
  call: (contactId: string) => boolean;
  answer: (callId: string) => boolean;
  choose: (choiceId: string) => boolean;
  ui: (kind: 'appOpened', ref: string) => void;
}

const liveActions: CallsActions = {
  call: (contactId) => sendPhoneAction({ type: 'call', contactId }),
  answer: (callId) => sendPhoneAction({ type: 'answerCall', callId }),
  choose: (choiceId) => sendPhoneAction({ type: 'callChoice', choiceId }),
  ui: (kind, ref) => {
    sendPhoneUi(kind, ref);
  },
};

const DIRECTION: Record<CallEntry['direction'], string> = {
  incoming: 'Входящий',
  outgoing: 'Исходящий',
  missed: 'Пропущенный',
};

/** A number that is not in the contacts is shown as unknown; the raw id is never displayed. */
function who(view: PhoneView, contactId: string): string {
  return view.contacts.find((c) => c.id === contactId)?.name ?? 'Неизвестный номер';
}

export function CallsApp({ view, actions = liveActions }: OsAppProps & { actions?: CallsActions }) {
  const [offline, setOffline] = useState(false);
  const [ended, setEnded] = useState(false);
  const scale = useTextScale();
  const wasCall = useRef(false);
  const call = view.activeCall;

  useEffect(() => {
    actions.ui('appOpened', 'calls');
  }, []);

  useEffect(() => {
    if (call) {
      wasCall.current = true;
      setEnded(false);
    } else if (wasCall.current) {
      wasCall.current = false;
      setEnded(true);
    }
  }, [call]);

  const send = (ok: boolean) => setOffline(!ok);

  if (call) {
    return (
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={[styles.status, { fontSize: 14 * scale }]}>
            {call.state === 'ringing' ? 'Входящий звонок' : 'Идёт звонок'}
          </Text>
          <Text style={[styles.who, { fontSize: 24 * scale }]}>{who(view, call.contactId)}</Text>
        </View>
        <ScrollView style={styles.flex} contentContainerStyle={styles.lines}>
          {call.lines.map((l, i) => (
            <View
              key={i}
              style={[styles.bubble, l.speaker === 'player' ? styles.mine : styles.theirs]}
            >
              <Text style={[styles.bubbleText, { fontSize: 15 * scale }]}>{l.text}</Text>
            </View>
          ))}
        </ScrollView>
        {offline ? <Text style={styles.offline}>Нет связи, ответ не отправлен</Text> : null}
        <View style={styles.choices}>
          {call.state === 'ringing' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ответить"
              onPress={() => send(actions.answer(call.callId))}
              style={[styles.choice, styles.answer]}
            >
              <Text style={[styles.choiceText, { fontSize: 15 * scale }]}>Ответить</Text>
            </Pressable>
          ) : (
            call.choices.map((c) => (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                onPress={() => send(actions.choose(c.id))}
                style={styles.choice}
              >
                <Text style={[styles.choiceText, { fontSize: 15 * scale }]}>{c.text}</Text>
              </Pressable>
            ))
          )}
        </View>
      </View>
    );
  }

  const log = [...view.callLog].sort((a, b) => b.at - a.at);
  return (
    <View style={styles.root}>
      {ended ? <Text style={styles.ended}>Звонок завершён</Text> : null}
      {offline ? <Text style={styles.offline}>Нет связи, звонок не отправлен</Text> : null}
      {log.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>Журнал звонков пуст</Text>
        </View>
      ) : (
        <ScrollView style={styles.flex}>
          {log.map((e) => {
            const name = who(view, e.contactId);
            const known = view.contacts.some((c) => c.id === e.contactId);
            return (
              <View key={e.id} style={styles.row}>
                <View style={styles.flex}>
                  <Text
                    style={[
                      styles.name,
                      e.direction === 'missed' ? styles.missed : null,
                      { fontSize: 16 * scale },
                    ]}
                  >
                    {name}
                  </Text>
                  <Text style={[styles.meta, { fontSize: 13 * scale }]}>
                    {DIRECTION[e.direction]}, {dayClock(e.at)}
                    {e.durationMinutes > 0 ? `, ${e.durationMinutes} мин` : ''}
                  </Text>
                </View>
                {known ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Позвонить: ${name}`}
                    onPress={() => send(actions.call(e.contactId))}
                    style={styles.callBack}
                  >
                    <Text style={styles.callBackText}>Позвонить</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: '#b4c2ba', fontSize: 16 },
  ended: { color: '#b4c2ba', padding: 12, textAlign: 'center' },
  offline: { color: '#d97a6c', paddingHorizontal: 16 },
  header: { padding: 16, gap: 4 },
  status: { color: '#b4c2ba' },
  who: { color: '#f0eee5', fontWeight: '700' },
  lines: { padding: 12, gap: 8 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#2f5a46' },
  theirs: { alignSelf: 'flex-start', backgroundColor: '#2a3430' },
  bubbleText: { color: '#f0eee5' },
  choices: { padding: 12, gap: 8 },
  choice: { padding: 12, borderRadius: 10, backgroundColor: '#1d2422' },
  answer: { backgroundColor: '#2f5a46' },
  choiceText: { color: '#f0eee5' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  name: { color: '#f0eee5', fontWeight: '700' },
  missed: { color: '#d97a6c' },
  meta: { color: '#b4c2ba', marginTop: 2 },
  callBack: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#1d2422',
  },
  callBackText: { color: '#d9a441' },
});
