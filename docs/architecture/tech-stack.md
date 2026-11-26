# Технологический стек и таблица версий

Версии проверены 30.10.2026 (npm registry, официальные changelog). Точные версии npm-пакетов
закрепляются в `package-lock.json` задачами фазы Foundation; эта таблица — целевые версии.
Изменение мажорной версии любой строки — через ADR.

## 1. Платформы и движки

| Компонент | Версия | Лицензия | Где закреплено | Обоснование |
|-----------|--------|----------|----------------|-------------|
| Godot Engine (стандартная сборка) | **4.7.2-stable** | MIT | `apps/desktop/project.godot`, CI | Обязателен; актуальная стабильная ([ADR 0011](adr/0011-godot-client-stack.md)) |
| Node.js | **24 LTS** (≥ 24.3) | MIT | `.nvmrc`, `package.json#engines` | LTS, требуется Expo SDK 58 ([ADR 0003](adr/0003-backend-stack.md)) |
| npm | 11.x | Artistic-2.0 | `package.json#packageManager` | Встроен в Node 24, workspaces |
| TypeScript | **6.0.x** | Apache-2.0 | корневой `package.json` | 7.0 (нативный компилятор) пока несовместим с typescript-eslint 8 (peer `<6.1`) |
| Expo SDK | **58** (`expo@58.0.x`) | MIT | `apps/mobile/package.json` | Актуальная стабильная; React Native 0.88 ([ADR 0007](adr/0007-mobile-stack.md)) |
| React Native | 0.88.x (определяется SDK) | MIT | через `npx expo install` | — |

## 2. TypeScript-пакеты (сервер, ядро, инструменты)

| Пакет | Версия | Лицензия | Используется в | Зачем |
|-------|--------|----------|----------------|-------|
| fastify | 5.12.x (5.12.8 в lockfile) | MIT | server | HTTP, валидация, `inject` для тестов |
| @fastify/websocket | 11.3.x | MIT | server | WebSocket-эндпоинт поверх ws |
| ws | 8.22.x | MIT | server, tools | WebSocket (сервер и тестовые клиенты) |
| @types/ws | 8.18.x | MIT | server (dev) | Типы WebSocket для шлюза и тестов |
| zod | 4.6.x | MIT | protocol, core, server, mobile | Схемы, вывод типов, JSON Schema |
| qrcode | 1.5.4 | MIT | server | Матрица QR ([ADR 0010](adr/0010-qr-rendering-on-server.md)) |
| @types/qrcode | 1.5.x (dev) | MIT | server | Типы для `qrcode` (в самом пакете их нет) |
| pino | 10.x (через Fastify) | MIT | server | Структурированные логи |
| vitest | 5.0.x | MIT | все TS-пакеты кроме mobile | Unit/integration тесты |
| @vitest/coverage-v8 | 5.0.x | MIT | все TS-пакеты кроме mobile | Покрытие и пороги в CI |
| fast-check | 4.10.x (4.10.3 в lockfile) | MIT | core, generator, validator | Property-based тесты инвариантов |
| tsx | 4.23.x (4.23.15 в lockfile) | MIT | server, tools | Запуск TS в разработке |
| eslint | 10.x | MIT | все | Линтинг, правила детерминизма |
| typescript-eslint | 8.72.x | MIT | все | TS-правила |
| prettier | 3.9.x | MIT | все | Форматирование |
| @types/node | 24.x | MIT | все TS-пакеты кроме mobile | Типы Node.js (TS 6 не подключает `@types/*` автоматически; см. `types` в `tsconfig.base.json`) |

`qrcode` тянет ≈ 25 транзитивных пакетов (в основном `yargs` ради его консольной утилиты, `pngjs`,
`dijkstrajs`); все под MIT или ISC.

Ядро (`@hs/core`) не имеет runtime-зависимостей, кроме `zod`. Хеширование SHA-256 — через
`node:crypto` за интерфейсом `Hasher` (ядро исполняется только в Node.js).

## 3. Мобильное приложение (только через `npx expo install`)

| Пакет | Версия | Expo Go | Зачем |
|-------|--------|---------|-------|
| expo-router | SDK 58 (58.0.x) | Да | Навигация |
| expo-constants, expo-linking, expo-status-bar | SDK 58 (58.0.x), MIT | Да | Зависимости каркаса Expo Router и системная строка |
| react, react-dom | 19.3.0, MIT | Да (React) | Единая версия React для React Native и зависимостей Expo Router |
| react-native-safe-area-context, react-native-screens | 5.11.x / 4.30.x, MIT | Да | Безопасная область и нативная навигация |
| react-native-gesture-handler, react-native-worklets | 3.3.x / 0.13.x, MIT | Да | Версии нативных зависимостей Expo Router, совместимые с Expo Go |
| expo-camera | SDK 58 (58.0.x), MIT | Да | Камера, сканирование QR (`CameraView`) |
| expo-secure-store | SDK 58, MIT | Да | Хранение `deviceToken` |
| @react-native-async-storage/async-storage | версия SDK 58 | Да | Настройки |
| expo-haptics | SDK 58 | Да | Вибрация уведомлений |
| expo-audio | SDK 58 | Да | Рингтон звонков, звуки ОС |
| react-native-reanimated | версия SDK 58 | Да | Анимации, эффекты глитча |
| zustand | 5.0.x | Да (чистый JS) | Состояние |
| zod | 4.6.x | Да (чистый JS) | Валидация входящих сообщений |
| jest-expo | 58.0.x | — (dev) | Тесты |
| @testing-library/react-native | 14.x | — (dev) | Тесты компонентов |
| jest, @types/jest, @types/react | 30.5.x / 30.0.x / 19.3.x, MIT | — (dev) | Раннер и типы для smoke-теста и TSX |

Нативных модулей вне Expo Go нет. Решение при появлении такой необходимости — [ADR 0007](adr/0007-mobile-stack.md).
Корневые npm `overrides` удерживают React и нативные зависимости Expo Router в версиях SDK 58,
чтобы npm не устанавливал рядом другую копию для транзитивных зависимостей.

## 4. Godot

| Аддон | Версия | Лицензия | Зачем |
|-------|--------|----------|-------|
| GUT (Godot Unit Test) | [9.7.1](https://github.com/bitwes/Gut/releases/tag/v9.7.1) | MIT, шрифты OFL 1.1 | Автотесты GDScript. Копия `addons/gut` из коммита `aeb5d4f3f7f0a6c9b5e178876d6c99b791fda605` |

Других аддонов нет. QR рисуется из матрицы сервера, сеть и JSON — встроенные API.

## 5. CI

| Инструмент | Версия |
|------------|--------|
| GitHub Actions `actions/checkout`, `actions/setup-node`, `actions/cache` | v7 / v7 / v6 (`actions/cache` — MIT) |
| Godot headless в CI | 4.7.2-stable Linux x86_64, официальный GitHub Releases `godotengine/godot-builds`, архив проверяется по SHA-512 |

## 6. Проверка совместимости

- Expo Go: все пакеты раздела 3 входят в Expo SDK или являются чистым JS.
- Expo Go для SDK 58: [App Store](https://apps.apple.com/us/app/expo-go/id982107779)
  указывает поддержку в версии 58.0.5. Сборки для Android доступны на [странице Expo Go](https://expo.dev/go).
- Expo Go требует входа в Expo-аккаунт для режима разработки (изменение 2026 г.).
- Node.js 24 удовлетворяет требованиям Vitest 5 (`^22.12 || ^24 || >=26`) и Expo SDK 58 (≥ 24.3).
- typescript-eslint 8.72 требует TypeScript `<6.1` — отсюда выбор TS 6.0.

## 7. Политика зависимостей

Перед добавлением зависимости агент обязан: проверить совместимость (Godot 4.7 / Expo SDK 58 /
Node 24), активность поддержки (релиз за последние 12 месяцев), лицензию (MIT, BSD, Apache-2.0,
ISC; иное — через владельца), необходимость (нельзя ли без неё). Результат записывается в эту
таблицу в том же PR.
