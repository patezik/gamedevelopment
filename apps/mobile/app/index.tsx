import { PROTOCOL_VERSION } from '@hs/protocol';
import { Link } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        Hollow Signal
      </Text>
      <Text style={styles.version}>Версия протокола {PROTOCOL_VERSION}</Text>
      <Link href="/os" style={styles.openPhone}>
        Открыть телефон
      </Link>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#131717',
  },
  title: {
    color: '#f0eee5',
    fontSize: 36,
    fontWeight: '700',
    textAlign: 'center',
  },
  version: {
    marginTop: 8,
    color: '#b4c2ba',
    fontSize: 16,
  },
  openPhone: {
    marginTop: 24,
    padding: 12,
    color: '#f0eee5',
    backgroundColor: '#283a36',
    borderRadius: 8,
    fontSize: 16,
  },
});
