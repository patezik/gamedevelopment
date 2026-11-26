import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HomeGrid } from '../../src/os/HomeGrid';
import { NotificationCenter } from '../../src/os/NotificationCenter';
import { StatusBar } from '../../src/os/StatusBar';
import { DEMO_PHONE_VIEW } from '../../src/os/demoPhoneView';
import { OS_APPS } from '../../src/os-apps/registry';

export default function OsHome() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar status={DEMO_PHONE_VIEW.status} />
      <View style={styles.grid}>
        <HomeGrid
          apps={OS_APPS}
          view={DEMO_PHONE_VIEW}
          onOpen={(appId) => router.push({ pathname: '/os/[appId]', params: { appId } })}
        />
      </View>
      <NotificationCenter
        view={DEMO_PHONE_VIEW}
        onOpenApp={(appId) => router.push({ pathname: '/os/[appId]', params: { appId } })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#131717' },
  grid: { flex: 1, justifyContent: 'flex-start' },
});
