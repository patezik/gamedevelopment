import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sendPhoneAction } from '../../connection/gameConnection';
import type { OsAppProps } from '../../os/types';
import { useTextScale } from '../../stores/displayStore';

export interface BrowserActions {
  /** Sends the `browse` action. The page text is already in `PhoneView`. */
  browse: (pageId: string) => void;
}

const liveActions: BrowserActions = {
  browse: (pageId) => {
    sendPhoneAction({ type: 'browse', pageId });
  },
};

/**
 * In-game browser: pages come from `PhoneView.browserPages`. Addresses are shown as plain text
 * and are never opened: the app has no means to leave the game.
 */
export function BrowserApp({
  view,
  actions = liveActions,
}: OsAppProps & { actions?: BrowserActions }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const scale = useTextScale();
  const page = view.browserPages.find((p) => p.id === openId);

  if (page) {
    return (
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="К списку страниц"
          onPress={() => setOpenId(null)}
          style={styles.back}
        >
          <Text style={styles.backText}>‹ Назад</Text>
        </Pressable>
        <Text accessibilityLabel="Адрес страницы" style={styles.url}>
          {page.url}
        </Text>
        <ScrollView style={styles.root} contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={[styles.title, { fontSize: 20 * scale }]}>
            {page.title}
          </Text>
          <Text style={[styles.text, { fontSize: 15 * scale }]}>{page.text}</Text>
        </ScrollView>
      </View>
    );
  }

  if (view.browserPages.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Нет сохранённых страниц</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root}>
      {view.browserPages.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityLabel={p.title}
          onPress={() => {
            actions.browse(p.id);
            setOpenId(p.id);
          }}
          style={styles.row}
        >
          <Text style={[styles.title, { fontSize: 16 * scale }]}>{p.title}</Text>
          <Text style={styles.url}>{p.url}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: '#b4c2ba', fontSize: 16 },
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  content: { padding: 16, gap: 8 },
  back: { paddingHorizontal: 16, paddingVertical: 8 },
  backText: { color: '#d9a441', fontSize: 16 },
  url: { color: '#b4c2ba', fontSize: 13, paddingHorizontal: 16 },
  title: { color: '#f0eee5', fontWeight: '700' },
  text: { color: '#f0eee5' },
});
