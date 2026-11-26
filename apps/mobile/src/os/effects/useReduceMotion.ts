import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReduceMotion(): boolean {
  // Wait for the system preference before showing motion.
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    let useInitialValue = true;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      useInitialValue = false;
      setReduced(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (useInitialValue) setReduced(enabled);
      },
      () => {
        // Keep effects off if the system preference is unavailable.
      },
    );
    return () => {
      useInitialValue = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
