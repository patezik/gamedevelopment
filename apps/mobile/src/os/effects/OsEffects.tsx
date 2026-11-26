import type { PhoneView } from '@hs/protocol';
import { usePathname } from 'expo-router';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useDisplayStore } from '../../stores/displayStore';
import { useReduceMotion } from './useReduceMotion';

const GlitchLevel = createContext(0);

export function useGlitchLevel(): number {
  return useContext(GlitchLevel);
}

const scanlines: {
  top: DimensionValue;
  left: DimensionValue;
  width: DimensionValue;
  height: number;
}[] = [
  { top: '11%', left: '0%', width: '83%', height: 1 },
  { top: '22%', left: '25%', width: '75%', height: 3 },
  { top: '38%', left: '5%', width: '52%', height: 1 },
  { top: '42%', left: '0%', width: '100%', height: 2 },
  { top: '65%', left: '20%', width: '57%', height: 5 },
  { top: '83%', left: '0%', width: '74%', height: 2 },
  { top: '93%', left: '58%', width: '42%', height: 1 },
];

export function OsEffects({
  effects,
  children,
}: {
  effects: PhoneView['effects'];
  children: ReactNode;
}) {
  const path = usePathname();
  const reduceEffects = useDisplayStore((state) => state.reduceEffects);
  const reduceMotion = useReduceMotion();
  const level = reduceEffects || reduceMotion || path === '/os/camera' ? 0 : effects.glitchLevel;
  const shift = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({
    // Removing an animated style would leave its last transform on the native view.
    transform: level > 0 ? [{ translateX: shift.value }] : undefined,
  }));

  useEffect(() => {
    if (level === 0) return;

    const amplitude = 4 * (level / 100);
    shift.value = withRepeat(
      withSequence(
        withDelay(2300, withTiming(amplitude, { duration: 75 })),
        withTiming(-amplitude * 0.65, { duration: 95 }),
        withTiming(0, { duration: 130 }),
      ),
      -1,
      false,
      undefined,
      // The live preference above already gates the loop and cancels it on change.
      ReduceMotion.Never,
    );
    return () => {
      cancelAnimation(shift);
      shift.value = 0;
    };
  }, [level, shift]);

  return (
    <GlitchLevel.Provider value={level}>
      <View style={styles.viewport}>
        <Animated.View testID="os-effect-surface" style={[styles.screen, shakeStyle]}>
          {children}
        </Animated.View>
        {level > 0 && (
          <View
            testID="os-static"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ ...StyleSheet.absoluteFill, opacity: level / 250 }}
          >
            {scanlines.map((line) => (
              <View key={line.top} style={[styles.scanline, line]} />
            ))}
          </View>
        )}
      </View>
    </GlitchLevel.Provider>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden', backgroundColor: '#131717' },
  screen: { flex: 1 },
  scanline: { position: 'absolute', backgroundColor: '#98b5ae' },
});
