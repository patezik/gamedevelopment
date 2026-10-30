# Архитектура: обзор

Этот документ — точка входа в техническую архитектуру. Детали модулей — в [modules.md](modules.md),
версии — в [tech-stack.md](tech-stack.md), решения — в [ADR](adr/README.md).

## 1. Компоненты

```
┌──────────────────────────────┐          ┌────────────────────────────────┐
│ Godot Desktop Client         │          │ Mobile Companion (Expo / RN)   │
│ apps/desktop (GDScript)      │          │ apps/mobile (TypeScript)       │
│ сцены, UI, ввод, аудио, FX   │          │ виртуальная ОС, камера, QR     │
└──────────────┬───────────────┘          └───────────────┬────────────────┘
               │ REST + WebSocket                         │ REST (pair) + WebSocket
               │ PlayerAction → / ← PlayerView, events    │ PhoneAction → / ← PhoneView, events
┌──────────────┴──────────────────────────────────────────┴────────────────┐
│ Session Server — apps/server (Node.js 24, Fastify 5, ws)                 │
│ sessions · pairing · gateway · views · qr · saves · diagnostics          │
│                                   │                                      │
│            ┌──────────────────────┴───────────────────────┐              │
│            │ @hs/core — Game Core (headless, детерминир.) │              │
│            │ time · world · characters · truth · knowledge│              │
│            │ simulation · evidence · investigation ·      │              │
│            │ survival · phone · game(engine, save)        │              │
│            └──────────────────────┬───────────────────────┘              │
│            @hs/generator (конвейер генерации) · @hs/validator (проверки) │
└──────────────────────────────────────────────────────────────────────────┘
               ▲ данные сценариев: content/scenarios/*  ·  схемы: @hs/protocol
```

## 2. Принципы

1. **Один авторитет состояния.** Game Core на сервере; клиенты присылают намерения и получают
   представления ([ADR 0002](adr/0002-headless-game-core.md)).
2. **Истина не покидает сервер.** Клиенты получают только `PlayerView` / `PhoneView` —
   проекции знаний игрока. Тест-гарантия: ENG-002.
3. **Детерминизм.** seed + версия генератора + журнал действий → идентичное состояние
   ([ADR 0004](adr/0004-determinism.md)).
4. **Данные отдельно от кода.** Сценарии, правила следов, шаблоны текстов — JSON в `content/`,
   валидируются схемами.
5. **Независимость от UI.** Ядро, генератор и валидатор тестируются без Godot и телефона.
6. **Без избыточной сложности.** Модульный монолит, без микросервисов и БД в MVP.

## 3. Поток одного действия игрока

1. Игрок нажимает «Осмотреть стол» в Godot → `action.request { type: "examine", target: "desk_01" }`.
2. Gateway проверяет соединение и роль, валидирует схему, ставит действие в очередь сессии.
3. `GameEngine.dispatch(action)`:
   1. проверка допустимости (локация, блокировка взаимодействия, ресурсы);
   2. `ActionCostResolver` → стоимость в минутах (например, 15);
   3. применение эффектов действия (обнаружение улик → `PlayerKnowledge`);
   4. `TimeSystem.advance(15)` → обработка очереди событий по фазам: календарь → расписания →
      симуляция NPC → мировые события → доступность локаций → таймеры улик/угроз → проверка исходов;
   5. возврат `DispatchResult { events, interrupted?, outcome? }`.
4. Сервер вычисляет новые `PlayerView` и `PhoneView`, увеличивает `stateVersion`, рассылает
   `view.update` и доменные события (`event` с `seq`) обоим клиентам; дописывает действие в сохранение.
5. Godot обновляет сцену; телефон показывает, например, уведомление о новом сообщении.

## 4. Поток QR-улики

1. Игрок осматривает предмет, улика которого требует фиксации телефоном (`captureMode: "qr"`).
2. Ядро через порт `EvidenceTokenPort` запрашивает токен → сервер выпускает `hs1:ev:…`.
3. Godot получает в `PlayerView` `pendingCapture { tokenId }`, запрашивает матрицу
   `GET …/evidence-qr/:tokenId` и показывает QR в оверлее «Сфотографируйте на телефон».
4. Телефон сканирует → `qr.scan { raw }` → сервер проверяет подпись, сессию, срок, однократность,
   предусловия → `GameEngine.dispatch({ type: "captureEvidence", tokenId })` (стоимость 2 минуты).
5. Улика появляется в галерее телефона (`PhoneView.gallery`), Godot закрывает оверлей.
   Подробнее — [qr-mechanics.md](../mobile/qr-mechanics.md).

## 5. Карта документации по подсистемам

| Подсистема | Документ |
|------------|----------|
| Модули и интерфейсы | [modules.md](modules.md) |
| Генерация | [generation-pipeline.md](../procedural-generation/generation-pipeline.md), [scenario-presets.md](../procedural-generation/scenario-presets.md) |
| Истина и расследование | [truth-model.md](../investigation/truth-model.md), [investigation-model.md](../investigation/investigation-model.md), [validation.md](../investigation/validation.md) |
| Симуляция и время | [character-simulation.md](../simulation/character-simulation.md), [time-system.md](../simulation/time-system.md) |
| Сервер и протокол | [backend.md](../backend/backend.md), [protocol.md](../backend/protocol.md) |
| Мобильное приложение | [mobile-app.md](../mobile/mobile-app.md), [qr-mechanics.md](../mobile/qr-mechanics.md) |
| Godot-клиент | [godot-client.md](../desktop/godot-client.md) |
| Тестирование | [testing-strategy.md](../testing/testing-strategy.md) |
