import { StyleSheet, Text, View } from 'react-native';

const PALETTE = ['#3a4a44', '#4a3f3a', '#2f3b4d', '#46402f', '#3d3447', '#2f4747'] as const;

/** FNV-1a: a stable, dependency-free hash so one `imageRef` always draws the same card. */
export function hashRef(ref: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ref.length; i += 1) {
    h = Math.imul(h ^ ref.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

export interface CardStyle {
  background: string;
  /** Count and tilt of the decorative stripes, from the ref only. */
  stripes: number;
  tilt: number;
}

/**
 * The look depends only on the hash of `imageRef`: a photo that is not evidence must not differ
 * from one that is (survival-horror.md section 5), so the ref prefix is deliberately not parsed.
 * Final images arrive with CNT-010; until then every ref is drawn as a stylised card.
 */
export function cardStyleFor(imageRef: string): CardStyle {
  const h = hashRef(imageRef);
  return {
    background: PALETTE[h % PALETTE.length]!,
    stripes: 3 + ((h >>> 8) % 4),
    tilt: ((h >>> 12) % 5) - 2,
  };
}

export interface EvidenceCardProps {
  imageRef: string;
  title: string;
  /** Edge of the square card in px. */
  size: number;
  fontScale?: number;
  showTitle?: boolean;
}

export function EvidenceCard({
  imageRef,
  title,
  size,
  fontScale = 1,
  showTitle = true,
}: EvidenceCardProps) {
  const style = cardStyleFor(imageRef);
  return (
    <View
      testID={`card-${imageRef}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={title}
      style={[styles.card, { width: size, height: size, backgroundColor: style.background }]}
    >
      {Array.from({ length: style.stripes }, (_, i) => (
        <View
          key={i}
          style={[
            styles.stripe,
            {
              top: ((i + 1) * size) / (style.stripes + 1),
              transform: [{ rotate: `${style.tilt}deg` }],
            },
          ]}
        />
      ))}
      {showTitle && (
        <Text
          numberOfLines={3}
          style={[styles.title, { fontSize: Math.max(11, size / 9) * fontScale }]}
        >
          {title}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 6, overflow: 'hidden', justifyContent: 'flex-end', padding: 6 },
  stripe: { position: 'absolute', left: -8, right: -8, height: 2, backgroundColor: '#ffffff18' },
  title: { color: '#f0eee5', fontWeight: '600' },
});
