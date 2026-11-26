import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { LOCALES, setLocale, t, useLocale } from '../../i18n';
import { unpairDevice } from '../../pairing/unpair';
import {
  TEXT_SCALE,
  useDisplayStore,
  useTextScale,
  type TextSize,
} from '../../stores/displayStore';
import { useSettingsStore } from '../../stores/settingsStore';

const SIZES: ReadonlyArray<{ id: TextSize; label: string }> = [
  { id: 'small', label: 'Мелкий' },
  { id: 'normal', label: 'Обычный' },
  { id: 'large', label: 'Крупный' },
];

export const PRIVACY_LINES: readonly string[] = [
  'Приложение использует только камеру: чтобы читать игровые QR-коды с экрана компьютера.',
  'Оно не читает ваши контакты, сообщения, фото, файлы, геолокацию и другие данные телефона.',
  'Все переписки, файлы и страницы в этом телефоне вымышленные и приходят от игры.',
  'Токен привязки хранится в защищённом хранилище телефона и удаляется при отвязке.',
];

export function SettingsScreen({ onUnpair }: { onUnpair: () => void | Promise<void> }) {
  const textSize = useDisplayStore((s) => s.textSize);
  const setTextSize = useDisplayStore((s) => s.setTextSize);
  const reduceEffects = useDisplayStore((s) => s.reduceEffects);
  const setReduceEffects = useDisplayStore((s) => s.setReduceEffects);
  const vibration = useSettingsStore((s) => s.vibration);
  const setVibration = useSettingsStore((s) => s.setVibration);
  const sound = useSettingsStore((s) => s.sound);
  const setSound = useSettingsStore((s) => s.setSound);
  const scale = useTextScale();
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const body = { fontSize: 15 * scale };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={[styles.label, body]}>Размер текста</Text>
      <View style={styles.sizes}>
        {SIZES.map((s) => (
          <Pressable
            key={s.id}
            accessibilityRole="button"
            accessibilityState={{ selected: textSize === s.id }}
            onPress={() => setTextSize(s.id)}
            style={[styles.size, textSize === s.id ? styles.sizeOn : null]}
          >
            <Text style={[styles.sizeText, { fontSize: 14 * TEXT_SCALE[s.id] }]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.label, body]}>{t('settings.language', locale)}</Text>
      <View style={styles.sizes}>
        {LOCALES.map((code) => (
          <Pressable
            key={code}
            accessibilityRole="button"
            accessibilityState={{ selected: code === locale }}
            accessibilityLabel={t(`language.${code}`, locale)}
            onPress={() => setLocale(code)}
            style={[styles.size, code === locale ? styles.sizeOn : null]}
          >
            <Text style={[styles.sizeText, { fontSize: 14 * scale }]}>
              {t(`language.${code}`, locale)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Row label="Вибрация" value={vibration} onChange={setVibration} size={body} />
      <Row label="Звук" value={sound} onChange={setSound} size={body} />
      <Row label="Снизить эффекты" value={reduceEffects} onChange={setReduceEffects} size={body} />

      <Text accessibilityRole="header" style={[styles.heading, body]}>
        О приложении и приватности
      </Text>
      {PRIVACY_LINES.map((line) => (
        <Text key={line} style={[styles.note, body]}>
          {line}
        </Text>
      ))}

      {confirming ? (
        <View style={styles.confirm}>
          <Text style={[styles.note, body]}>Отвязать это устройство от игры?</Text>
          <View style={styles.confirmButtons}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setConfirming(false)}
              style={styles.cancel}
            >
              <Text style={styles.btnText}>Отмена</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Подтвердить отвязку"
              onPress={() => void onUnpair()}
              style={styles.danger}
            >
              <Text style={styles.btnText}>Отвязать</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Отвязать устройство"
          onPress={() => setConfirming(true)}
          style={styles.danger}
        >
          <Text style={styles.btnText}>Отвязать устройство</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

function Row({
  label,
  value,
  onChange,
  size,
}: {
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  size: { fontSize: number };
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, size]}>{label}</Text>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} />
    </View>
  );
}

export function SettingsApp() {
  const router = useRouter();
  return (
    <SettingsScreen
      onUnpair={async () => {
        await unpairDevice();
        router.replace('/pair');
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 12 },
  label: { color: '#f0eee5' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sizes: { flexDirection: 'row', gap: 8 },
  size: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1d2422' },
  sizeOn: { backgroundColor: '#2f5a46' },
  sizeText: { color: '#f0eee5' },
  heading: { color: '#f0eee5', fontWeight: '700', marginTop: 12 },
  note: { color: '#b4c2ba' },
  confirm: { gap: 8, marginTop: 12 },
  confirmButtons: { flexDirection: 'row', gap: 12 },
  cancel: { padding: 12, borderRadius: 10, backgroundColor: '#1d2422' },
  danger: { padding: 12, borderRadius: 10, backgroundColor: '#8a2f2f', marginTop: 12 },
  btnText: { color: '#f0eee5', fontSize: 15, fontWeight: '700' },
});
