import { useState } from 'react';
import type { GalleryItemView } from '@hs/protocol';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatCaseTime } from '../../os/caseTime';
import { PhotoPreview } from '../../os/effects/PhotoPreview';
import type { OsAppProps } from '../../os/types';
import { useTextScale } from '../../stores/displayStore';
import { EvidenceCard } from './EvidenceCard';

export const ZOOM_LEVELS = [1, 1.5, 2, 3] as const;
const THUMB = 104;
const FULL = 280;

export function GalleryApp({ view }: OsAppProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const scale = useTextScale();
  const items = [...view.gallery].sort((a, b) => b.takenAt - a.takenAt);
  const open = items.find((i) => i.id === openId);

  if (items.length === 0) {
    return (
      <View style={styles.screen}>
        <Text style={[styles.empty, { fontSize: 16 * scale }]}>Снимков пока нет.</Text>
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.grid}>
        {items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`Снимок: ${item.title}`}
            onPress={() => setOpenId(item.id)}
          >
            <PhotoPreview>
              <EvidenceCard
                imageRef={item.imageRef}
                title={item.title}
                size={THUMB}
                fontScale={scale}
                showTitle={false}
              />
            </PhotoPreview>
            <Text style={[styles.title, { fontSize: 14 * scale }]}>{item.title}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {open ? <Viewer item={open} scale={scale} onClose={() => setOpenId(null)} /> : null}
    </View>
  );
}

function Viewer({
  item,
  scale,
  onClose,
}: {
  item: GalleryItemView;
  scale: number;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(0);
  const level = ZOOM_LEVELS[zoom]!;
  const atMin = zoom === 0;
  const atMax = zoom === ZOOM_LEVELS.length - 1;
  return (
    <Modal visible animationType="none" transparent onRequestClose={onClose}>
      <View style={styles.viewer}>
        <ScrollView
          horizontal
          maximumZoomScale={3}
          minimumZoomScale={1}
          contentContainerStyle={styles.zoomPane}
        >
          <ScrollView contentContainerStyle={styles.zoomPane}>
            <EvidenceCard
              imageRef={item.imageRef}
              title={item.title}
              size={FULL * level}
              fontScale={scale}
            />
          </ScrollView>
        </ScrollView>
        <Text accessibilityRole="header" style={[styles.title, { fontSize: 18 * scale }]}>
          {item.title}
        </Text>
        <Text style={[styles.meta, { fontSize: 15 * scale }]}>
          {`Время: ${formatCaseTime(item.takenAt)}`}
        </Text>
        {item.caption ? (
          <Text style={[styles.meta, { fontSize: 15 * scale }]}>{`Место: ${item.caption}`}</Text>
        ) : null}
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Уменьшить"
            accessibilityState={{ disabled: atMin }}
            disabled={atMin}
            style={[styles.button, atMin && styles.off]}
            onPress={() => setZoom(zoom - 1)}
          >
            <Text style={styles.buttonText}>−</Text>
          </Pressable>
          <Text style={styles.meta}>{`×${level}`}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Увеличить"
            accessibilityState={{ disabled: atMax }}
            disabled={atMax}
            style={[styles.button, atMax && styles.off]}
            onPress={() => setZoom(zoom + 1)}
          >
            <Text style={styles.buttonText}>+</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            style={styles.button}
            onPress={onClose}
          >
            <Text style={styles.buttonText}>Закрыть</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { color: '#b4c2ba', textAlign: 'center', marginTop: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 12 },
  viewer: { flex: 1, backgroundColor: '#131717f2', padding: 12, gap: 6 },
  zoomPane: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#f0eee5', fontWeight: '700' },
  meta: { color: '#b4c2ba' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  button: {
    backgroundColor: '#283a36',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  off: { opacity: 0.5 },
  buttonText: { color: '#f0eee5', fontSize: 16 },
});
