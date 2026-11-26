import { Slot, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NotificationCenter } from '../../src/os/NotificationCenter';
import { usePhoneView } from '../../src/os/usePhoneView';

/** One notification centre survives navigation between the home screen and every phone app. */
export default function OsLayout() {
  const router = useRouter();
  const view = usePhoneView();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <Slot />
      <View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, { top: insets.top, bottom: insets.bottom }]}
      >
        <NotificationCenter
          view={view}
          onOpenApp={(appId) => router.push({ pathname: '/os/[appId]', params: { appId } })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1 } });
