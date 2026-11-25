import { StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';

/** Signal as four bars: 0 means no bars, 100 all four. */
export function signalBars(signal: number): number {
  return Math.ceil(signal / 25);
}

export function StatusBar({ status }: { status: PhoneView['status'] }) {
  const bars = signalBars(status.signal);
  return (
    <View style={styles.bar}>
      <Text style={styles.text}>{status.time}</Text>
      <View style={styles.right}>
        <Text accessibilityLabel={`Сигнал ${status.signal}%`} style={styles.text}>
          {'▮'.repeat(bars) + '▯'.repeat(4 - bars)}
        </Text>
        <Text accessibilityLabel={`Заряд ${status.battery}%`} style={styles.text}>
          {status.battery}%
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  right: { flexDirection: 'row', gap: 12 },
  text: { color: '#f0eee5', fontSize: 14, fontVariant: ['tabular-nums'] },
});
