# Настройка окружения

> Статус: документ описывает целевое окружение. Команды, отмеченные «после FND-…», появятся
> после выполнения соответствующих задач. Проверка документа на чистой машине — задача FND-010.

## 1. Требования

| Инструмент | Версия | Зачем |
|------------|--------|-------|
| Git | 2.40+ | — |
| Node.js | 24 LTS (≥ 24.3), см. `.nvmrc` | сервер, ядро, инструменты, Expo CLI |
| npm | 11.x (идёт с Node 24) | workspaces |
| Godot | 4.7.2-stable (стандартная сборка, не .NET) | desktop-клиент |
| Expo Go | версия для Expo SDK 58 на телефоне | запуск мобильного приложения |
| Аккаунт Expo | бесплатный | Expo Go требует входа (`npx expo login`) |

Телефон и компьютер должны быть в **одной локальной сети** (без изоляции клиентов, как в гостевых
Wi-Fi).

## 2. Первый запуск

```bash
git clone <repo-url> hollow-signal
cd hollow-signal
npm ci                      # установка зависимостей всех workspaces
npm run tasks:check         # проверка задач (работает сразу)
npm run docs:check          # проверка ссылок документации (работает сразу)
```

## 3. Команды

| Команда | Что делает | Доступна |
|---------|-----------|----------|
| `npm run tasks:ready` | готовые к взятию задачи | сейчас |
| `npm run tasks:index` | обновить `tasks/INDEX.md` | сейчас |
| `npm run tasks:check` | валидация задач | сейчас |
| `npm run docs:check` | проверка относительных ссылок в Markdown | сейчас |
| `npm run lint` / `typecheck` / `test` | проверки TS-кода (на пустом наборе пакетов завершаются с кодом 0) | сейчас |
| `npm run format` / `format:check` | форматирование Prettier (Markdown не форматируется) | сейчас |
| `npm run dev:server` | Session Server на `0.0.0.0:7420` | после FND-005, FND-010 |
| `npm run dev:mobile` | `npx expo start` в `apps/mobile` | после FND-006, FND-010 |
| `npm run test:godot` | GUT-тесты Godot headless (`GODOT_BIN`) | после FND-008 |
| `npm run sweep -- --scenario <id> --count N` | seed sweep | после VAL-007 |
| `npm run protocol:gen` / `protocol:check` | регенерация схем и GDScript-констант | после FND-004, PROTO-003 |
| `npm run content:check` | валидация данных сценариев | после CNT-001 |

## 4. Godot

1. Скачайте Godot 4.7.2-stable с godotengine.org или установите пакетным менеджером
   (Windows: `winget install GodotEngine.GodotEngine`).
2. Задайте переменную `GODOT_BIN` — путь к исполняемому файлу (на Windows — `*_console.exe` для
   вывода в терминал).
3. Откройте `apps/desktop/project.godot` в редакторе.

## 5. Мобильное приложение

```bash
npx expo login               # один раз
npm run dev:mobile           # покажет QR Expo Go — это QR разработки, не игровой
```

Отсканируйте QR Expo Go камерой (iOS) или из приложения Expo Go (Android). Игровой QR привязки
сканируется уже **внутри** нашего приложения (см. [qr-mechanics.md](../mobile/qr-mechanics.md)).

## 6. Сеть и брандмауэр

- Windows: при первом запуске сервера разрешите доступ Node.js в **частных** сетях.
- macOS: разрешите входящие подключения для `node` в настройках брандмауэра.
- Если у компьютера несколько адресов (VPN, WSL, Docker), выберите адрес домашней сети на экране
  привязки или задайте `HS_PUBLIC_HOST=<ip>` (после SRV-008).

## 7. Частые проблемы

| Симптом | Причина | Решение |
|---------|---------|---------|
| Телефон не подключается к серверу | разные сети, гостевой Wi-Fi, брандмауэр | одна сеть, разрешить Node в брандмауэре, проверить адрес |
| Expo Go: «project is incompatible» | версия Expo Go не совпадает с SDK | обновить Expo Go; см. ADR 0007 о версиях |
| Expo Go просит войти | требование Expo Go 2026 | `npx expo login` и вход в приложении |
| Порт 7420 занят | другой процесс | `HS_PORT=7421 npm run dev:server` |
