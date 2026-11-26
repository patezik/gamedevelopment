import { StyleSheet, Text, View } from 'react-native';
import { isOfflineBanner, useConnectionStore } from '../stores/connectionStore';

export function OfflineBanner() {
  const status = useConnectionStore((s) => s.status);
  if (!isOfflineBanner(status)) {
    return null;
  }
  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Text style={styles.text}>Нет связи с игрой</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: '#7a2f2f', paddingVertical: 6, paddingHorizontal: 12 },
  text: { color: '#f0eee5', fontSize: 14, textAlign: 'center' },
});
