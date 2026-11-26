import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { sendPhoneAction } from '../../connection/gameConnection';
import { formatCaseTime } from '../../os/caseTime';
import type { OsAppProps } from '../../os/types';
import { useConnectionStore } from '../../stores/connectionStore';

const MAX_NOTE = 500;
export const NOTE_OFFLINE = 'Нет связи с игрой. Заметка не отправлена.';

export function NotesApp({ view }: OsAppProps) {
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const online = useConnectionStore((s) => s.status === 'online');
  const trimmed = draft.trim();
  const notes = [...view.notes].sort((a, b) => b.at - a.at);

  function submit() {
    if (!trimmed) {
      return;
    }
    if (!online || !sendPhoneAction({ type: 'addNote', text: trimmed })) {
      setMessage(NOTE_OFFLINE);
      return;
    }
    setMessage(null);
    setDraft('');
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        ListEmptyComponent={<Text style={styles.empty}>Записей пока нет.</Text>}
        renderItem={({ item }) => (
          <View style={styles.note}>
            <Text style={styles.meta}>
              {item.source === 'auto' ? 'Журнал' : 'Заметка'} · {formatCaseTime(item.at)}
            </Text>
            <Text style={styles.text}>{item.text}</Text>
          </View>
        )}
      />
      {message ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {message}
        </Text>
      ) : null}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Новая заметка"
          style={styles.input}
          placeholder="Новая заметка"
          placeholderTextColor="#7c8a83"
          maxLength={MAX_NOTE}
          value={draft}
          onChangeText={setDraft}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !trimmed }}
          disabled={!trimmed}
          style={[styles.button, !trimmed && styles.buttonOff]}
          onPress={submit}
        >
          <Text style={styles.buttonText}>Добавить</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 12, gap: 8 },
  empty: { color: '#b4c2ba', fontSize: 16, textAlign: 'center', marginTop: 24 },
  note: { backgroundColor: '#1d2523', borderRadius: 8, padding: 12, marginBottom: 8 },
  meta: { color: '#7c8a83', fontSize: 13, marginBottom: 4 },
  text: { color: '#f0eee5', fontSize: 16 },
  error: { color: '#e8a0a0', fontSize: 15 },
  row: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    color: '#f0eee5',
    backgroundColor: '#1d2523',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#283a36',
    borderRadius: 8,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  buttonOff: { opacity: 0.5 },
  buttonText: { color: '#f0eee5', fontSize: 16 },
});
