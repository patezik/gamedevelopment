import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { sendQrScan } from '../../connection/gameConnection';
import { playSound } from '../../os/feedback';
import { useConnectionStore } from '../../stores/connectionStore';
import { useQrStore } from '../../stores/qrStore';
import { MESSAGE_CHECKING, MESSAGE_OFFLINE, qrResultMessage } from './errors';
import { handleScan, type LastScan } from './handleScan';

export function CameraApp() {
  const [permission, requestPermission] = useCameraPermissions();
  const [unavailable, setUnavailable] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const lastRef = useRef<LastScan | null>(null);
  const status = useConnectionStore((s) => s.status);
  const result = useQrStore((s) => s.result);
  const pending = useQrStore((s) => s.pending);

  useEffect(() => {
    if (result) {
      playSound(result.ok ? 'scanOk' : 'error');
    }
  }, [result]);

  function onScanned(raw: string) {
    const scan = handleScan(raw, {
      now: Date.now(),
      last: lastRef.current,
      online: status === 'online',
      send: sendQrScan,
    });
    lastRef.current = scan.last;
    switch (scan.outcome.kind) {
      case 'ignored':
        return;
      case 'rejected':
        useQrStore.getState().reset();
        setRejection(scan.outcome.message);
        playSound('error');
        return;
      case 'sent':
        setRejection(null);
        useQrStore.getState().markSent();
    }
  }

  if (!permission) {
    return <View style={styles.box} />;
  }
  if (!permission.granted) {
    return (
      <View style={styles.box}>
        <Text style={styles.text}>
          Камера нужна только чтобы фотографировать улики на экране игры. Фото не сохраняются на
          телефоне.
        </Text>
        {permission.canAskAgain ? (
          <Pressable accessibilityRole="button" style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>Разрешить камеру</Text>
          </Pressable>
        ) : (
          <>
            <Text style={styles.text}>Доступ к камере запрещён. Включите его в настройках.</Text>
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
    );
  }
  if (unavailable) {
    return (
      <View style={styles.box}>
        <Text accessibilityRole="alert" style={styles.text}>
          Камера недоступна: её может занимать другое приложение, либо это симулятор. Улики вручную
          не вводятся.
        </Text>
      </View>
    );
  }

  let message: string | null = rejection;
  if (status !== 'online') {
    message = MESSAGE_OFFLINE;
  } else if (pending) {
    message = MESSAGE_CHECKING;
  } else if (result) {
    message = qrResultMessage(result);
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => onScanned(data)}
        onMountError={() => setUnavailable(true)}
      />
      {message ? (
        <Text accessibilityRole="alert" style={styles.banner}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  text: { color: '#b4c2ba', fontSize: 16, textAlign: 'center' },
  button: { backgroundColor: '#283a36', borderRadius: 8, padding: 14 },
  buttonText: { color: '#f0eee5', fontSize: 16 },
  banner: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 24,
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(19,23,23,0.9)',
    color: '#f0eee5',
    fontSize: 16,
    textAlign: 'center',
  },
});
