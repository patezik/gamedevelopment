import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useGlitchLevel } from './OsEffects';

const PREVIEW_HEIGHT = 112;
const slices = [
  { top: 29, height: 10, direction: 1, tint: '#59777165' },
  { top: 63, height: 14, direction: -1, tint: '#a36a8755' },
];

export function PhotoPreview({ children }: { children: ReactNode }) {
  const level = useGlitchLevel();
  const offset = 14 * (level / 100);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.preview}
    >
      {children}
      {level > 0 && (
        <View
          testID="photo-preview-distortion"
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          {slices.map(({ top, height, direction, tint }) => (
            <View key={top} style={[styles.slice, { top, height }]}>
              <View
                style={[
                  styles.copy,
                  { top: -top, transform: [{ translateX: offset * direction }] },
                ]}
              >
                {children}
              </View>
              <View
                style={[StyleSheet.absoluteFill, { backgroundColor: tint, opacity: level / 100 }]}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: {
    height: PREVIEW_HEIGHT,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#243230',
  },
  slice: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  copy: { position: 'absolute', left: 0, right: 0, height: PREVIEW_HEIGHT },
});
