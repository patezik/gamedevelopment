import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';
import { StatusBar } from './StatusBar';
import { GlitchTitle } from './effects/GlitchTitle';

export interface AppFrameProps {
  status: PhoneView['status'];
  title: string;
  onHome: () => void;
  children: ReactNode;
}

export function AppFrame({ status, title, onHome, children }: AppFrameProps) {
  return (
    <View style={styles.frame}>
      <StatusBar status={status} />
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Домой"
          onPress={onHome}
          hitSlop={8}
        >
          <Text style={styles.home}>⌂</Text>
        </Pressable>
        <GlitchTitle title={title} style={styles.title} />
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: '#131717' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  home: { color: '#f0eee5', fontSize: 28 },
  title: { color: '#f0eee5', fontSize: 18, fontWeight: '600' },
  body: { flex: 1 },
});
