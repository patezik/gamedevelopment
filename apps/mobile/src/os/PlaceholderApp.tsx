import { StyleSheet, Text, View } from 'react-native';

/** Stand-in until the real app lands (MOB-004, MOB-006...MOB-010). */
export function PlaceholderApp({ title }: { title: string }) {
  return (
    <View style={styles.box}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.note}>В разработке</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#f0eee5', fontSize: 28, fontWeight: '700' },
  note: { marginTop: 8, color: '#b4c2ba', fontSize: 16 },
});
