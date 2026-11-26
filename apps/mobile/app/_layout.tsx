import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { OfflineBanner } from '../src/connection/OfflineBanner';
import { startGameConnection, stopGameConnection } from '../src/connection/gameConnection';

export default function RootLayout() {
  const router = useRouter();
  useEffect(() => {
    void startGameConnection({
      appVersion: Constants.expoConfig?.version ?? '0.0.0',
      onRevoked: () => router.replace('/pair'),
    });
    return stopGameConnection;
  }, [router]);

  return (
    <>
      <StatusBar style="light" />
      <OfflineBanner />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
