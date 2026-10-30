# Стандарты кода

## 1. Общие

- Идентификаторы, имена файлов, API, комментарии в коде — **на английском**. Документация — на русском.
- Пишите код, похожий на окружающий: те же имена, идиомы, плотность комментариев.
- Комментарий объясняет «почему», а не «что». Ссылайтесь на ADR/документ, если код реализует решение.
- Никаких «на будущее» абстракций, пустых файлов, закомментированного кода.

## 2. TypeScript (`packages/*`, `apps/server`, `apps/mobile`, `tools`)

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Без `any` (исключение —
  границы с внешними библиотеками, с комментарием).
- Имена: `PascalCase` для типов/классов, `camelCase` для функций/переменных, `SCREAMING_SNAKE_CASE`
  для констант модуля, `kebab-case.ts` для файлов.
- Данные на границах (сеть, файлы контента) валидируются zod; внутри — доверяем типам.
- Ошибки домена — коды из `ErrorCode` / `*_ERROR` констант модуля, а не произвольные строки.
- Публичный API модуля — через его `index.ts`; глубокие импорты в чужой модуль запрещены.
- Тесты — рядом: `foo.ts` → `foo.test.ts`; property-тесты — `test/properties/*.prop.test.ts`.

### Детерминизм (ADR 0004)

В `packages/core`, `packages/generator`, `packages/validator`:

- запрещены `Math.random`, `Date.now`, `new Date()`, `performance.now`, `crypto.randomUUID`;
- случайность — `Rng` с подпотоком `rng.fork("<module>/<purpose>")`;
- обход коллекций, влияющих на результат, — в отсортированном по id порядке;
- сравнения float-порогов — после `roundTo(x, 6)`.

Правила проверяются ESLint (FND-002).

### Границы модулей

- `apps/mobile` не импортирует `@hs/core`, `@hs/generator`, `@hs/validator`.
- `packages/core/src/investigation/**` не импортирует `truth`, кроме `accusation.ts`.
- `@hs/validator` не импортирует `@hs/generator` (кроме CLI sweep).
- Направление зависимостей модулей ядра — [modules.md](../architecture/modules.md).

## 3. GDScript (`apps/desktop`)

- Статическая типизация везде (`var x: int`, `func f(a: String) -> void`); предупреждения о типах —
  ошибки (настройки проекта).
- `snake_case` для файлов, функций, переменных; `PascalCase` для `class_name` и узлов.
- Сигналы — прошедшее время: `view_changed`, `action_failed`.
- Сцены не обращаются друг к другу; общение — через autoload `GameStore`/`SceneRouter` и сигналы.
- Никаких игровых правил в GDScript (ADR 0002).
- Строки протокола — только из сгенерированного `protocol_constants.gd`.

## 4. React Native (`apps/mobile`)

- Функциональные компоненты, хуки; состояние — Zustand-сторы в `src/stores`.
- Логика вне компонентов (чистые функции) — чтобы её можно было тестировать без рендера.
- Приложения виртуальной ОС не импортируют друг друга.
- Expo-пакеты — только через `npx expo install`.

## 5. Данные контента

- JSON с отступом 2 пробела, ключи `camelCase`, id — `snake_case` с префиксами (`loc_`, `it_`, `ch_` — только в рантайме).
- Тексты — в `text/<lang>/`, не в коде.
- Каждое изменение контента — `npm run content:check` и sweep на 200+ seed.
