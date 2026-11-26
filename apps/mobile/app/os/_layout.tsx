import { Slot, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sendPhoneAction } from '../../src/connection/gameConnection';
import { NotificationCenter } from '../../src/os/NotificationCenter';
import { usePhoneView } from '../../src/os/usePhoneView';
import { OsEffects } from '../../src/os/effects/OsEffects';

/** One notification centre survives navigation between the home screen and every phone app. */
export default function OsLayout() {
  const router = useRouter();
  const view = usePhoneView();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <OsEffects effects={view.effects}>
        <Slot />
      </OsEffects>
      <View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, { top: insets.top, bottom: insets.bottom }]}
      >
        <NotificationCenter
          view={view}
          onAnswerCall={(callId) => {
            sendPhoneAction({ type: 'answerCall', callId });
          }}
          onOpenApp={(appId) => router.push({ pathname: '/os/[appId]', params: { appId } })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1 } });
