import { Image, StyleSheet, View } from 'react-native';
import dayForest from '../../../../desktop/assets/art/scenarios/sanatorium_winter/locations/loc_lake_path.dim.png';
import nightForest from '../../../../desktop/assets/art/scenarios/sanatorium_winter/locations/loc_lake_path.dark.png';

const variants = new Map([
  ['pine_forest', { source: dayForest, tint: '#131717ad' }],
  ['pine_forest_noise', { source: dayForest, tint: '#1b3334af' }],
  ['pine_forest_static', { source: dayForest, tint: '#383638c4' }],
  ['pine_forest_silhouette', { source: nightForest, tint: '#39212f7d' }],
  ['pine_forest_inverted', { source: dayForest, tint: '#372443ba' }],
  ['pine_forest_dark', { source: nightForest, tint: '#131717ad' }],
  ['static_2', { source: nightForest, tint: '#39212f7d' }],
]);

export function Wallpaper({ variant }: { variant: string | undefined }) {
  const wallpaper = variant === undefined ? undefined : variants.get(variant);
  if (!wallpaper) return null;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Image
        testID="os-wallpaper"
        source={wallpaper.source}
        style={styles.image}
        resizeMode="cover"
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: wallpaper.tint }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  image: { width: '100%', height: '100%' },
});
