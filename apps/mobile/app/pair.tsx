import { CameraView, useCameraPermissions } from 'expo-camera';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pairDevice, pairErrorMessage } from '../src/pairing/pairClient';
import {
  parseManualEntry,
  parsePairingQr,
  QR_REJECTION_MESSAGES,
  type PairingTarget,
} from '../src/pairing/parsePairingQr';
import { startGameConnection, stopGameConnection } from '../src/connection/gameConnection';
import { savePairing } from '../src/pairing/storage';

export default function PairScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function connect(target: PairingTarget) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await pairDevice(target, Constants.expoConfig?.version ?? '0.0.0');
      if (!result.ok) {
        setMessage(pairErrorMessage(result.code));
        return;
      }
      await savePairing(result.device);
      stopGameConnection();
      void startGameConnection({
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        onRevoked: () => router.replace('/pair'),
      });
      router.replace('/os');
    } catch {
      setMessage('Не удалось сохранить привязку на телефоне. Повторите попытку.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function onScanned(raw: string) {
    if (busyRef.current) {
      return;
    }
    const parsed = parsePairingQr(raw);
    if (!parsed.ok) {
      setMessage(QR_REJECTION_MESSAGES[parsed.reason]);
      return;
    }
    void connect(parsed.target);
  }

  function onManualSubmit() {
    const target = parseManualEntry(address, code);
    if (!target) {
      setMessage('Проверьте адрес (хост:порт, например 192.168.1.5:7420) и 6-символьный код.');
      return;
    }
    void connect(target);
  }

  const canScan = permission?.granted === true && !manual;

  return (
    <SafeAreaView style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        Привязка телефона
      </Text>
      {canScan ? (
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy ? undefined : ({ data }) => onScanned(data)}
        />
      ) : null}
      {!manual && permission && !permission.granted ? (
        <View style={styles.block}>
          <Text style={styles.text}>
            Камера нужна только чтобы сканировать QR на экране игры: привязку телефона и игровые
            улики.
          </Text>
          {permission.canAskAgain ? (
            <Pressable accessibilityRole="button" style={styles.button} onPress={requestPermission}>
              <Text style={styles.buttonText}>Разрешить камеру</Text>
            </Pressable>
          ) : (
            <>
              <Text style={styles.text}>
                Доступ к камере запрещён. Включите его в настройках или введите адрес и код вручную.
              </Text>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => void Linking.openSettings()}
              >
                <Text style={styles.buttonText}>Открыть настройки</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}
      {manual ? (
        <View style={styles.block}>
          <TextInput
            accessibilityLabel="Адрес игры"
            style={styles.input}
            placeholder="host:port"
            placeholderTextColor="#7c8a83"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={address}
            onChangeText={setAddress}
          />
          <TextInput
            accessibilityLabel="Код привязки"
            style={styles.input}
            placeholder="Код"
            placeholderTextColor="#7c8a83"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={8}
            value={code}
            onChangeText={setCode}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            style={styles.button}
            onPress={onManualSubmit}
          >
            <Text style={styles.buttonText}>Привязать</Text>
          </Pressable>
        </View>
      ) : null}
      {busy ? <Text style={styles.text}>Подключаемся…</Text> : null}
      {message ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {message}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        style={styles.link}
        onPress={() => {
          setManual(!manual);
          setMessage(null);
        }}
      >
        <Text style={styles.linkText}>{manual ? 'Сканировать QR' : 'Ввести вручную'}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: '#131717' },
  title: { color: '#f0eee5', fontSize: 28, fontWeight: '700', marginBottom: 12 },
  camera: { flex: 1, borderRadius: 12, overflow: 'hidden' },
  block: { gap: 12 },
  text: { color: '#b4c2ba', fontSize: 16, marginVertical: 8 },
  error: { color: '#e8a0a0', fontSize: 16, marginVertical: 8 },
  input: {
    color: '#f0eee5',
    backgroundColor: '#1d2523',
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
  },
  button: { backgroundColor: '#283a36', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#f0eee5', fontSize: 16 },
  link: { padding: 12, alignItems: 'center' },
  linkText: { color: '#b4c2ba', fontSize: 16, textDecorationLine: 'underline' },
});
