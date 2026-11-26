import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppFrame } from '../../src/os/AppFrame';
import { usePhoneView } from '../../src/os/usePhoneView';
import { findApp } from '../../src/os-apps/registry';

export default function OsAppScreen() {
  const { appId } = useLocalSearchParams<{ appId: string }>();
  const router = useRouter();
  const view = usePhoneView();
  const app = findApp(appId);
  const App = app?.component;
  return (
    <SafeAreaView style={styles.screen}>
      <AppFrame
        status={view.status}
        title={app?.title ?? 'Нет приложения'}
        onHome={() => router.replace('/os')}
      >
        {App ? (
          <App
            view={view}
            openApp={(id) => router.replace({ pathname: '/os/[appId]', params: { appId: id } })}
          />
        ) : (
          <Text style={styles.missing}>Приложение не найдено</Text>
        )}
      </AppFrame>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#131717' },
  missing: { color: '#f0eee5', padding: 16 },
});
