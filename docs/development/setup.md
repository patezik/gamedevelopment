# Настройка окружения

## 1. Требования

| Инструмент | Версия | Зачем |
|------------|--------|-------|
| Git | 2.40+ | — |
| Node.js | 24 LTS (≥ 24.3), см. `.nvmrc` | сервер, ядро, инструменты, Expo CLI |
| npm | 11.x (идёт с Node 24) | workspaces |
| Godot | 4.7.2-stable (стандартная сборка, не .NET) | desktop-клиент |
| Expo Go | версия для Expo SDK 58 на телефоне | запуск мобильного приложения |
| Аккаунт Expo | бесплатный | один аккаунт в Expo CLI и Expo Go для физического iPhone |

Телефон и компьютер должны быть в **одной локальной сети** (без изоляции клиентов, как в гостевых
Wi-Fi).

## 2. Первый запуск

Команды в руководстве выполняются из корня клона, если не указано иначе.

**Windows (PowerShell)**

```powershell
git clone https://github.com/patezik/gamedevelopment.git hollow-signal
cd hollow-signal
npm.cmd ci
npm.cmd run tasks:check
npm.cmd run docs:check
```

Используйте `npm.cmd` и `npx.cmd` вместо `npm` и `npx`, если PowerShell блокирует запуск
`npm.ps1` или `npx.ps1`. Менять политику выполнения скриптов для этого не требуется.

**macOS и Linux (терминал)**

```bash
git clone https://github.com/patezik/gamedevelopment.git hollow-signal
cd hollow-signal
npm ci
npm run tasks:check
npm run docs:check
```

## 3. Команды

| Команда | Что делает | Доступна |
|---------|-----------|----------|
| `npm run tasks:ready` | готовые к взятию задачи | сейчас |
| `npm run tasks:index` | обновить `tasks/INDEX.md` | сейчас |
| `npm run tasks:check` | валидация задач | сейчас |
| `npm run docs:check` | проверка относительных ссылок в Markdown | сейчас |
| `npm run lint` / `npm run typecheck` / `npm test` | ESLint, TypeScript и Vitest (включая сервер) | сейчас |
| `npm run format` / `format:check` | форматирование Prettier (Markdown не форматируется) | сейчас |
| `npm run dev:server` | Session Server на `0.0.0.0:7420` с перезапуском при изменениях | сейчас |
| `npm run start -w @hs/server` | Session Server без режима наблюдения | сейчас |
| `npm run dev:mobile` | Expo CLI и Metro для Expo Go в `apps/mobile` | сейчас |
| `npm run test:all` | Vitest, Jest в `@hs/mobile` и GUT последовательно, с остановкой при ошибке (`GODOT_BIN`) | сейчас |
| `npm run test:godot` | GUT-тесты Godot headless (`GODOT_BIN`) | сейчас |
| `npm run sweep -- --scenario <id> --count N` | seed sweep | после VAL-007 |
| `npm run protocol:gen` / `npm run protocol:check` | регенерация и проверка схем и GDScript-констант | сейчас |
| `npm run content:check` | валидация данных сценариев и ссылок между файлами | сейчас |

Из корня запустите `npm run dev:server` (`npm.cmd run dev:server` в PowerShell) и проверьте
`http://localhost:7420/api/v1/health` в браузере или во втором терминале. Остановите процесс
через Ctrl+C. `npm run start -w @hs/server` запускает тот же сервер без наблюдения за файлами.
Ответ health подтверждает запуск сервера. Создание полноценной игровой сессии зависит от SRV-002.

### Конфигурация сервера

Сервер читает переменные процесса. При запуске через npm файлы `.env` автоматически не загружаются.
С настройками по умолчанию файл не нужен. Чтобы загрузить файл явно, скопируйте
[`.env.example`](../../.env.example) в `.env`, настройте значения и из корня выполните:

```bash
node --env-file=.env apps/server/src/server.ts
```

Например, для смены порта в режиме разработки задайте его в терминале запуска:

```powershell
$env:HS_PORT = '7421'
npm.cmd run dev:server
# После остановки сервера:
Remove-Item Env:HS_PORT
```

```bash
HS_PORT=7421 npm run dev:server
```

При другом порте подставьте его в URL проверки и при подключении с телефона.

## 4. Godot

1. Скачайте стандартную сборку [Godot 4.7.2-stable](https://github.com/godotengine/godot-builds/releases/tag/4.7.2-stable).
2. Задайте переменную `GODOT_BIN` — путь к исполняемому файлу (на Windows — `*_console.exe` для
   вывода в терминал).
3. Откройте `apps/desktop/project.godot` в редакторе.

Запустите тесты из корня репозитория. Команда сама импортирует проект и запускает GUT.

**Windows (PowerShell)**

```powershell
$env:GODOT_BIN = 'C:\Tools\Godot\Godot_v4.7.2-stable_win64_console.exe'
npm.cmd run test:godot
```

**macOS** (если приложение находится в `/Applications/Godot.app`)

```bash
export GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot
npm run test:godot
```

**Linux** (подставьте путь к распакованному исполняемому файлу)

```bash
export GODOT_BIN=/path/to/godot
npm run test:godot
```

## 5. Мобильное приложение

Для проверки на физическом iPhone выполните из корня `npx expo login` (`npx.cmd expo login`
в PowerShell) и войдите в тот же аккаунт в Expo Go. Подключите телефон к той же сети Wi-Fi.
См. [инструкцию Expo](https://docs.expo.dev/get-started/start-developing/#open-the-app-on-your-device).

В отдельном терминале выполните `npm run dev:mobile` (`npm.cmd run dev:mobile` в PowerShell).
Metro покажет локальный адрес `exp://...` и QR разработки. Отсканируйте QR штатной камерой iPhone,
откройте ссылку в Expo Go и при запросе разрешите доступ к локальной сети. Дождитесь загрузки
стартового экрана. Игровой QR привязки сканируется внутри приложения
(см. [qr-mechanics.md](../mobile/qr-mechanics.md)).

## 6. Сеть и брандмауэр

Для проверки запущенного сервера откройте `http://localhost:7420/api/v1/health`. Ответ содержит
`status`, версию сервера и версию протокола. Переменные окружения перечислены в
[документации сервера](../backend/backend.md).

### Какой адрес попадёт в QR

Сервер слушает все интерфейсы (`0.0.0.0`), но телефону нужен один адрес компьютера в вашей сети.
`GET /api/v1/network` возвращает кандидатов `{ address, interface, recommended, virtual }`:

- Отбрасываются только заведомо непригодные адреса: loopback (`127.*`), link-local (`169.254.*`),
  `0.0.0.0`, multicast и IPv6.
- Адреса, похожие на Docker, WSL/Hyper-V, виртуальные машины и VPN (по имени интерфейса, префиксу
  MAC-адреса или диапазону Docker `172.17.0.0/16`), остаются в списке с `virtual: true` и идут
  последними. Определение эвристическое: оно не знает, в какой сети ваш телефон.
- `recommended: true` получает один адрес: самый «домашний» из не виртуальных (`192.168.*`, затем `10.*`,
  затем `172.16–31.*`). Если нашлись только виртуальные, рекомендации нет, выбирайте вручную.
- `HS_PUBLIC_HOST=<ip или имя>` (без порта) отменяет определение: этот адрес идёт первым и
  рекомендован. Используйте его, если рекомендованный адрес неверный (две сети, VPN без признаков).

Проверить адрес можно с телефона: откройте в его браузере `http://<адрес>:7420/api/v1/health`
(телефон и компьютер в одной сети). Ответ подтверждает, что телефон видит HTTP-сервер по этому адресу.

### Брандмауэр

Без разрешения входящих подключений телефон не достучится, даже если адрес верный.

- **Windows:** при первом запуске нажмите «Разрешить» для Node.js в **частных** сетях. Если окна не
  было: «Брандмауэр Защитника Windows» → «Разрешение взаимодействия с приложением» → Node.js →
  «Частная». Либо в PowerShell от администратора:
  `New-NetFirewallRule -DisplayName "Hollow Signal" -Direction Inbound -Protocol TCP -LocalPort 7420 -Action Allow -Profile Private`.
  Домашняя сеть должна иметь профиль «Частная», а не «Общедоступная».
- **macOS:** «Системные настройки» → «Сеть» → «Брандмауэр» → «Параметры» → разрешите входящие
  подключения для `node`.
- **Linux (firewalld, например Fedora):** `sudo firewall-cmd --add-port=7420/tcp` (до перезагрузки)
  или с `--permanent`, затем `sudo firewall-cmd --reload`.
- Если задан другой `HS_PORT`, используйте его вместо 7420. Для Expo Go с телефона также нужен
  доступ к порту Metro (по умолчанию 8081, фактический порт указан в URL `exp://...`).
- Гостевой Wi-Fi и «изоляция клиентов» на роутере запрещают устройствам видеть друг друга: нужна
  обычная домашняя сеть.

## 7. Частые проблемы

- При `EADDRINUSE` проверьте, какой процесс использует порт, или запустите сервер с другим
  `HS_PORT` по примеру в разделе 3.
- Если `test:godot` сообщает об отсутствии `GODOT_BIN` или `ENOENT`, задайте путь к исполняемому файлу
  в текущем терминале. В Windows укажите `*_console.exe`, в macOS — бинарник внутри `Godot.app`.
  Из того же терминала можно запустить `npm run test:all`.
- Если QR Expo Go открывается, но загрузка встаёт, проверьте доступ к Metro по Wi-Fi, разрешение
  «Локальная сеть» для Expo Go в iOS и профиль сети брандмауэра. После смены Wi-Fi перезапустите Metro.

| Симптом | Причина | Решение |
|---------|---------|---------|
| Телефон не подключается к серверу | разные сети, гостевой Wi-Fi, брандмауэр | одна сеть, разрешить Node в брандмауэре, проверить адрес |
| Expo Go: «project is incompatible» | версия Expo Go не совпадает с SDK | обновить Expo Go; см. ADR 0007 о версиях |
| Expo Go просит войти | требование Expo Go 2026 | `npx expo login` и вход в приложении |
| Порт 7420 занят | другой процесс | задайте `HS_PORT=7421` и запустите `npm run dev -w @hs/server` |
