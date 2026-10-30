# Mobile Companion App (`apps/mobile`)

Стек — [ADR 0007](../architecture/adr/0007-mobile-stack.md). QR — [qr-mechanics.md](qr-mechanics.md).

## 1. Принципы

- Нативное приложение React Native (Expo), **не PWA и не веб-страница**.
- Приложение — «телефон героя»: виртуальная ОС с собственными приложениями. Все данные — игровые,
  приходят с сервера в `PhoneView`.
- **Никакого доступа к реальным личным данным** (контакты, SMS, фото, звонки, геолокация).
  Единственное разрешение — камера, и только для сканирования игровых QR.
- Сервер — авторитет; приложение не хранит игровое состояние, кроме кэша последнего
  `PhoneView` для мгновенного отображения при переподключении.

## 2. Структура

```
apps/mobile/
├── app/                         — Expo Router
│   ├── _layout.tsx              — провайдеры, подключение, глобальные оверлеи (уведомления, звонок)
│   ├── index.tsx                — редирект: нет токена → /pair, есть → /os
│   ├── pair.tsx                 — экран привязки (скан QR привязки / ручной ввод)
│   └── os/
│       ├── index.tsx            — домашний экран ОС (сетка приложений)
│       └── [appId].tsx          — открывает приложение из реестра
├── src/
│   ├── os/                      — оболочка: StatusBar, HomeGrid, AppFrame, NotificationCenter, IncomingCallOverlay, effects/
│   ├── os-apps/                 — по каталогу на приложение
│   │   ├── registry.ts          — список манифестов (единственное место регистрации)
│   │   ├── camera/  contacts/  messages/  gallery/  notes/  maps/  browser/  files/  calls/  settings/
│   ├── connection/              — WsClient, backoff, протокольные обработчики
│   ├── stores/                  — Zustand: connectionStore, phoneStore (PhoneView), uiStore
│   ├── pairing/                 — разбор QR привязки, POST /pair, SecureStore
│   └── lib/                     — общие утилиты
└── app.json                     — разрешения: только камера (iOS NSCameraUsageDescription, Android CAMERA)
```

## 3. Реестр приложений виртуальной ОС

```ts
interface OsAppManifest {
  id: string;                         // "messages"
  title: string;                      // "Сообщения"
  icon: IconRef;
  component: React.ComponentType<OsAppProps>;
  badge?: (view: PhoneView) => number;
  enabled?: (view: PhoneView) => boolean;   // например, браузер без сигнала при Static ≥ 90
  order: number;
}
```

Чтобы добавить приложение: создать каталог `src/os-apps/<id>/` с `manifest.ts` и компонентом,
добавить одну строку в `registry.ts`. Приложения не импортируют друг друга; общаются через
`phoneStore` и действия (`sendAction`). Тест реестра проверяет уникальность `id` и наличие компонентов.

## 4. Приложения (MVP)

| Приложение | Данные (`PhoneView`) | Действия |
|------------|----------------------|----------|
| Camera | — | сканирование QR → `qr.scan` |
| Contacts | `contacts` | открыть контакт → позвонить / написать |
| Calls | `callLog`, `activeCall` | `call`, `answerCall`, `callChoice` (выбор реплики во время звонка) |
| Messages | `threads` | `message` (шаблонные ответы из `availableReplies`) |
| Gallery | `gallery` (снимки улик, сюжетные фото) | просмотр, увеличение, метаданные |
| Files | `files` (документы, скрытые/зашифрованные) | `openFile`, `unlockFile(password)` |
| Notes | `notes` (авто-журнал + заметки игрока) | `addNote` |
| Maps | `mapPins` (локации, наблюдения) | — |
| Browser | `browserPages` (внутриигровые страницы) | `browse(pageId)` |
| Settings | локальные настройки | размер текста, вибрация, снижение эффектов, отвязать устройство, о приложении и приватности |

## 5. Состояние и подключение

- `connectionStore`: `status: "unpaired" | "connecting" | "online" | "reconnecting" | "offline"`,
  `lastSeq`, `stateVersion`, ошибки.
- `phoneStore`: последний `PhoneView`; обновляется только из `view.update` (с проверкой
  `stateVersion` по возрастанию).
- Все входящие сообщения валидируются zod-схемами `@hs/protocol`; невалидные — лог + игнор.
- Переподключение: экспоненциальная задержка ([protocol.md §7](../backend/protocol.md)); при
  `DEVICE_REVOKED` — удаление токена и возврат на `/pair`.
- Приложение в фоне: соединение закрывается ОС; при возврате — `hello` с `resume`.

## 6. Иммерсивность

- Входящие сообщения и звонки инициирует сервер (`event`): оверлей звонка, вибрация, звук.
- Неизвестные контакты, изменения контактов, новые фото, скрытые файлы — данные `PhoneView`.
- Психологические эффекты: `effects.glitchLevel` управляет шейдероподобными эффектами
  (reanimated): дрожание, шум, подмена обоев. Настройка «Снизить эффекты» ограничивает их.

## 7. Тесты

- Сторы (Zustand) — чистые unit-тесты.
- `WsClient` — с mock WebSocket: resume, backoff, невалидные сообщения.
- Разбор QR (pairing/evidence/неизвестный формат) — unit.
- Компоненты приложений — RNTL на фикстурах `PhoneView` из `@hs/protocol/fixtures`.
- Ручной чек-лист на реальных устройствах (Android + iOS) — INT-003.
- E2E (Maestro) — после MVP (QA-001).

## 8. Запуск в Expo Go

```bash
npm run dev:server            # в корне репозитория
npm run start -w @hs/mobile   # npx expo start; отсканировать QR Expo Go (это QR разработки!)
```

Телефон и компьютер — в одной сети. Expo Go требует входа в Expo-аккаунт.
