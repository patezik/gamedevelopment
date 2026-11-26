import type { MapPinView } from '@hs/protocol';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatCaseTime } from '../../os/caseTime';
import type { OsAppProps } from '../../os/types';

/** Pins grouped by place, in order of first appearance; a pin has no place name, only an id. */
export function groupPins(pins: readonly MapPinView[]): MapPinView[][] {
  const groups = new Map<string, MapPinView[]>();
  for (const pin of pins) {
    const group = groups.get(pin.locationId);
    if (group) {
      group.push(pin);
    } else {
      groups.set(pin.locationId, [pin]);
    }
  }
  return [...groups.values()];
}

export function MapsApp({ view }: OsAppProps) {
  const places = groupPins(view.mapPins);
  if (places.length === 0) {
    return (
      <View style={styles.screen}>
        <Text style={styles.empty}>Известных мест пока нет.</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {places.map((pins, index) => (
        <View key={pins[0]!.locationId} style={styles.place}>
          <Text accessibilityRole="header" style={styles.title}>
            {`Место ${index + 1}`}
          </Text>
          {pins.map((pin) => (
            <Text key={pin.id} style={styles.pin}>
              {pin.seenAt === undefined
                ? pin.label
                : `${pin.label} · замечен(а) ${formatCaseTime(pin.seenAt)}`}
            </Text>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 12, gap: 8 },
  empty: { color: '#b4c2ba', fontSize: 16, textAlign: 'center', marginTop: 24 },
  place: { backgroundColor: '#1d2523', borderRadius: 8, padding: 12, gap: 4 },
  title: { color: '#f0eee5', fontSize: 18, fontWeight: '700' },
  pin: { color: '#b4c2ba', fontSize: 16 },
});
