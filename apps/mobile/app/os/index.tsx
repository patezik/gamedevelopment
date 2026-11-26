import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { HomeGrid } from '../../src/os/HomeGrid';
import { StatusBar } from '../../src/os/StatusBar';
import { usePhoneView } from '../../src/os/usePhoneView';
import { OS_APPS } from '../../src/os-apps/registry';

export default function OsHome() {
  const router = useRouter();
  const view = usePhoneView();
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar status={view.status} />
      <View style={styles.grid}>
        <HomeGrid
          apps={OS_APPS}
          view={view}
          onOpen={(appId) => router.push({ pathname: '/os/[appId]', params: { appId } })}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#131717' },
  grid: { flex: 1, justifyContent: 'flex-start' },
});
