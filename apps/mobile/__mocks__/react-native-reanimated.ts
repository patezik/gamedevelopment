// Jest's iOS preset has no native Worklets runtime. Keep the component and its styles testable.
import { useRef } from 'react';
import { View } from 'react-native';

export default { View };
export const useSharedValue = (initial: number) => useRef({ value: initial }).current;
export const useAnimatedStyle = <Style>(updater: () => Style) => updater();
export const withTiming = jest.fn((target: number) => target);
export const withDelay = (_duration: number, target: number) => target;
export const withSequence = (...targets: number[]) => targets.at(-1);
export const withRepeat = jest.fn((target: number) => target);
export const cancelAnimation = jest.fn();
