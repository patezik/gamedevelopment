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
│   ├── index.tsx                — версия протокола и вход в демонстрационную оболочку
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
  icon: IconRef;                      // { glyph: string } — текстовый символ, без картинок и иконочных шрифтов
  component: React.ComponentType<OsAppProps>;
  badge?: (view: PhoneView) => number;
  enabled?: (view: PhoneView) => boolean;   // например, браузер без сигнала при Static ≥ 90
  order: number;
}
```

Чтобы добавить приложение: создать каталог `src/os-apps/<id>/` с `manifest.ts` и компонентом,
добавить одну строку в `registry.ts`. Бейдж и доступность по умолчанию берутся из `PhoneView.apps`
(`badge`, `enabled`); `badge`/`enabled` манифеста переопределяют бейдж и могут только дополнительно
отключить приложение. До подключения сервера оболочка работает на фикстуре `phone-view.mid.json`
(`src/os/demoPhoneView.ts`), а до реальных приложений каждое — заглушка «В разработке». Приложения не импортируют друг друга; общаются через
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

### Контент телефона в пресете

Контент лежит в `content/scenarios/<id>/phone/*.json` в формате `phoneTemplatesSchema`
([scenario-presets.md §7](../procedural-generation/scenario-presets.md)). Записи без `event`
попадают в стартовый телефон героя (`initialPhoneState`): страницы, файлы и единственные стартовые
обои. Записи с `event` сервер выдаёт при наступлении события; записи с одинаковыми `event` и видом —
варианты, из которых выбирает `Rng`. Выдачу по событиям реализует движок; контент только называет
события.

В `sanatorium_winter` (CNT-006): `browser.json` (сайт санатория, распорядок, история, новости,
погода, форум), `files.json` (путёвка, памятки, оповещение МЧС, файлы планшета медсестры),
`messages.json` (сообщения NPC), `wallpapers.json` (обои и их искажения). Полноту событий,
подстановки и согласованность с данными сценария проверяет `sanatorium-phone.test.ts`.

| Событие | Что выдаёт | Подстановки |
|---------|------------|-------------|
| `npc_tip_presence`, `npc_tip_item`, `npc_tip_place` | наводка NPC: кто где был, у кого вещь, куда заглянуть | `{who}`, `{who_f}`, `{where}`, `{time}`, `{item}`, `{me_f}` |
| `npc_rumor_presence`, `npc_rumor_relation`, `npc_rumor_vague` | слух: с чужих слов, об отношениях, без фактов | `{who}`, `{who_f}`, `{where}`, `{time}`, `{a}`, `{b}`, `{relation}`, `{me_f}` |
| `npc_threat` | анонимная угроза ([survival-horror.md §4](../game-design/survival-horror.md)) | — |
| `npc_request_meet`, `npc_request_item`, `npc_request_discretion` | просьба о встрече, о вещи, о молчании | `{where}`, `{time}`, `{item}`, `{me_f}` |
| `contact_shared`, `interrogated_calm`, `interrogated_nervous`, `interrogated_hostile` | реакция: NPC дал номер; NPC пишет после допроса, тон выбирает вызывающий код | `{me_f}` |
| `incident_discovered`, `secondary_incident` | известие о теле или о вторичном инциденте | `{who}`, `{who_f}`, `{where}`, `{me_f}` |
| `blackout` | сообщения, новость, тёмные обои; `id` из `preset.criticalEvents` | `{me_f}` |
| `night` | ночные сообщения (период `night`) | `{me_f}` |
| `static_25`, `static_50`, `static_75` | пороги Static ([survival-horror.md §3](../game-design/survival-horror.md)): обои, сообщения с неизвестных номеров, файлы и страницы-сбои | — |
| `sanity_low`, `rest` | искажённые обои при рассудке не выше `phoneInterferenceSanity`; исходные обои после отдыха | — |

Подстановки — как в текстовых шаблонах CNT-005: `{who}` — имя в именительном падеже, `{where}` и
`{item}` — названия (в тексте они стоят в кавычках «»), `{who_f}` и `{me_f}` — окончание «а» для
женского рода субъекта и отправителя. Тексты наводок и слухов одинаковы для правды и лжи:
подстановки берутся из убеждений отправителя, а не из истины. Сообщения не называют архетипов и
имён из пулов, поэтому отправителем, жертвой или виновником может оказаться любой персонаж.
Страницы, файлы и обои подстановок не содержат.

Шаблон обоев — идентификатор варианта (`pine_forest`, `pine_forest_noise`, `pine_forest_static`,
`pine_forest_silhouette`, `pine_forest_inverted`, `pine_forest_dark`), `title` — описание для
художника (CNT-010). Файлы планшета медсестры есть в телефоне с начала, но скрыты и заперты:
движок раскрывает их событием `FileRevealed`, когда герой находит планшет `it_nurse_tablet` (схема
шаблона не выражает это условие), а пароль герой узнаёт со стикера `it_password_note` в дежурной
комнате процедурного корпуса. Галлюцинаций контент не содержит, их генерирует SURV-005.

## 7. Тесты

- Сторы (Zustand) — чистые unit-тесты.
- `WsClient` — с mock WebSocket: resume, backoff, невалидные сообщения.
- Разбор QR (pairing/evidence/неизвестный формат) — unit.
- Компоненты приложений — RNTL на фикстурах `PhoneView` из `@hs/protocol/fixtures`.
- Ручной чек-лист на физическом iPhone — INT-003. Проверка Android вынесена в [MOB-012](../../tasks/MOB-012.md).
- E2E (Maestro) — после MVP (QA-001).

## 8. Запуск в Expo Go

Из корня репозитория:

```bash
npm ci
npm run start -w @hs/mobile
npm run typecheck -w @hs/mobile
npm test -w @hs/mobile
```

Установите Expo Go с поддержкой SDK 58 и отсканируйте QR разработки из терминала. Телефон и
компьютер должны быть в одной сети. В Expo Go и Expo CLI войдите в один аккаунт. На стартовом
экране нажмите «Открыть телефон». Оболочка использует демоданные, сервер игры ей не требуется.
Откройте «Заметки» и нажмите «Домой» для проверки возврата. «Браузер» отключён в демоданных.
