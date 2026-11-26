import { useEffect, useRef, useState } from 'react';
import type { FileView, PhoneView } from '@hs/protocol';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { sendPhoneAction } from '../../connection/gameConnection';
import type { OsAppProps } from '../../os/types';
import { useConnectionStore } from '../../stores/connectionStore';
import { useTextScale } from '../../stores/displayStore';

export const FILE_OFFLINE = 'Нет связи с игрой. Действие не отправлено.';
export const WRONG_PASSWORD = 'Неверный пароль. Файл остался закрытым.';

export interface FolderGroup {
  /** Empty string for files in the root. */
  folder: string;
  files: FileView[];
}

/** The view has flat names; a `/` in a name is a folder. Root files come first. */
export function buildTree(files: readonly FileView[]): FolderGroup[] {
  const groups = new Map<string, FileView[]>();
  for (const file of files) {
    const cut = file.name.lastIndexOf('/');
    const folder = cut < 0 ? '' : file.name.slice(0, cut);
    const group = groups.get(folder);
    if (group) {
      group.push(file);
    } else {
      groups.set(folder, [file]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, files: list }));
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

export function FilesApp({ view }: OsAppProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const scale = useTextScale();
  const file = view.files.find((f) => f.id === openId);

  if (file) {
    return <Document file={file} view={view} onBack={() => setOpenId(null)} />;
  }
  if (view.files.length === 0) {
    return (
      <View style={styles.screen}>
        <Text style={[styles.empty, { fontSize: 16 * scale }]}>Файлов пока нет.</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {buildTree(view.files).map((group) => (
        <View key={group.folder} style={styles.group}>
          {group.folder ? (
            <Text accessibilityRole="header" style={[styles.folder, { fontSize: 15 * scale }]}>
              {`📁 ${group.folder}`}
            </Text>
          ) : null}
          {group.files.map((f) => (
            <Pressable
              key={f.id}
              accessibilityRole="button"
              accessibilityLabel={
                f.locked ? `${baseName(f.name)}, закрыт паролем` : baseName(f.name)
              }
              style={styles.row}
              onPress={() => {
                setOpenId(f.id);
                if (!f.locked) {
                  sendPhoneAction({ type: 'openFile', fileId: f.id });
                }
              }}
            >
              <Text style={[styles.name, { fontSize: 16 * scale }]}>
                {`${f.locked ? '🔒' : '📄'} ${baseName(f.name)}`}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function Document({ file, view, onBack }: { file: FileView; view: PhoneView; onBack: () => void }) {
  const scale = useTextScale();
  const online = useConnectionStore((s) => s.status === 'online');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  /** The view at the moment of the attempt: the next view tells whether it worked. */
  const pendingFrom = useRef<PhoneView | null>(null);

  useEffect(() => {
    if (pendingFrom.current && pendingFrom.current !== view) {
      pendingFrom.current = null;
      setMessage(file.locked ? WRONG_PASSWORD : null);
      setPassword('');
    }
  }, [view, file.locked]);

  function submit() {
    if (!password || pendingFrom.current) {
      return;
    }
    if (!online || !sendPhoneAction({ type: 'unlockFile', fileId: file.id, password })) {
      setMessage(FILE_OFFLINE);
      return;
    }
    setMessage(null);
    pendingFrom.current = view;
  }

  return (
    <View style={styles.screen}>
      <Pressable accessibilityRole="button" accessibilityLabel="К списку файлов" onPress={onBack}>
        <Text style={[styles.back, { fontSize: 16 * scale }]}>‹ Файлы</Text>
      </Pressable>
      <Text accessibilityRole="header" style={[styles.docTitle, { fontSize: 18 * scale }]}>
        {baseName(file.name)}
      </Text>
      {file.locked ? (
        <View style={styles.group}>
          <Text style={[styles.text, { fontSize: 16 * scale }]}>Файл защищён паролем.</Text>
          {file.passwordHint ? (
            <Text style={[styles.hint, { fontSize: 15 * scale }]}>
              {`Подсказка: ${file.passwordHint}`}
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel="Пароль"
            style={[styles.input, { fontSize: 16 * scale }]}
            placeholder="Пароль"
            placeholderTextColor="#7c8a83"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={submit}
          />
          {message ? (
            <Text accessibilityRole="alert" style={[styles.error, { fontSize: 15 * scale }]}>
              {message}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !password }}
            disabled={!password}
            style={[styles.button, !password && styles.off]}
            onPress={submit}
          >
            <Text style={[styles.buttonText, { fontSize: 16 * scale }]}>Открыть</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView>
          <Text style={[styles.text, { fontSize: 16 * scale }]}>{file.content ?? ''}</Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, padding: 12, gap: 8 },
  empty: { color: '#b4c2ba', textAlign: 'center', marginTop: 24 },
  group: { gap: 6 },
  folder: { color: '#7c8a83', marginTop: 4 },
  row: { backgroundColor: '#1d2523', borderRadius: 8, padding: 12 },
  name: { color: '#f0eee5' },
  back: { color: '#b4c2ba' },
  docTitle: { color: '#f0eee5', fontWeight: '700' },
  text: { color: '#f0eee5' },
  hint: { color: '#b4c2ba' },
  error: { color: '#e8a0a0' },
  input: { color: '#f0eee5', backgroundColor: '#1d2523', borderRadius: 8, padding: 12 },
  button: {
    backgroundColor: '#283a36',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignSelf: 'flex-start',
  },
  off: { opacity: 0.5 },
  buttonText: { color: '#f0eee5' },
});
