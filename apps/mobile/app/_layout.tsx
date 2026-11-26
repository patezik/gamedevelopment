import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { OfflineBanner } from '../src/connection/OfflineBanner';
import { startGameConnection, stopGameConnection } from '../src/connection/gameConnection';
import { startSettingsPersistence } from '../src/stores/persistSettings';

export default function RootLayout() {
  const router = useRouter();
  useEffect(() => {
    void startGameConnection({
      appVersion: Constants.expoConfig?.version ?? '0.0.0',
      onRevoked: () => router.replace('/pair'),
    });
    return stopGameConnection;
  }, [router]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void startSettingsPersistence().then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <OfflineBanner />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
