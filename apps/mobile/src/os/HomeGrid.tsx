import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PhoneView } from '@hs/protocol';
import type { OsAppManifest } from './types';

export interface HomeGridProps {
  apps: readonly OsAppManifest[];
  view: PhoneView;
  onOpen: (appId: string) => void;
}

/** Server flags can only disable an app; a manifest can narrow further. */
export function isAppEnabled(app: OsAppManifest, view: PhoneView): boolean {
  const entry = view.apps.find((a) => a.id === app.id);
  return (entry?.enabled ?? true) && (app.enabled?.(view) ?? true);
}

export function appBadge(app: OsAppManifest, view: PhoneView): number {
  return app.badge?.(view) ?? view.apps.find((a) => a.id === app.id)?.badge ?? 0;
}

export function HomeGrid({ apps, view, onOpen }: HomeGridProps) {
  return (
    <View style={styles.grid}>
      {apps.map((app) => {
        const enabled = isAppEnabled(app, view);
        const badge = appBadge(app, view);
        return (
          <Pressable
            key={app.id}
            accessibilityRole="button"
            accessibilityLabel={badge > 0 ? `${app.title}, ${badge}` : app.title}
            accessibilityState={{ disabled: !enabled }}
            disabled={!enabled}
            onPress={() => onOpen(app.id)}
            style={[styles.cell, !enabled && styles.disabled]}
          >
            <View style={styles.icon}>
              <Text style={styles.glyph}>{app.icon.glyph}</Text>
              {badge > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </View>
            <Text style={styles.label}>{app.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 12 },
  cell: { width: '25%', alignItems: 'center', paddingVertical: 12 },
  disabled: { opacity: 0.4 },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: '#25302c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 28 },
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#c0392b',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  label: { marginTop: 6, color: '#f0eee5', fontSize: 12, textAlign: 'center' },
});
