import { useEffect, useState } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useGlitchLevel } from './OsEffects';

export function GlitchTitle({ title, style }: { title: string; style: StyleProp<TextStyle> }) {
  const enabled = useGlitchLevel() >= 50;
  const [glitched, setGlitched] = useState(false);

  useEffect(() => {
    setGlitched(false);
    if (!enabled) return;

    let restore: ReturnType<typeof setTimeout> | undefined;
    const interval = setInterval(() => {
      setGlitched(true);
      restore = setTimeout(() => setGlitched(false), 180);
    }, 5000);
    return () => {
      clearInterval(interval);
      clearTimeout(restore);
    };
  }, [enabled, title]);

  return (
    <Text accessibilityLabel={title} style={style}>
      {enabled && glitched ? 'ШУМ' : title}
    </Text>
  );
}
