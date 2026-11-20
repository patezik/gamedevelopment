# Выпуск Hollow Signal

## Версии

Desktop, Session Server и companion-приложение получают одну продуктовую версию
`MAJOR.MINOR.PATCH` при совместном выпуске. Для исправлений увеличивайте `PATCH`, для совместимых
функций — `MINOR`, для несовместимых изменений публичного API — `MAJOR`. Для разработки
служит ряд `0.x`, для кандидатов — суффикс вида `-rc.1`.
[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)

| Компонент | Где менять версию |
|---|---|
| Desktop | `application/config/version` в `apps/desktop/project.godot` |
| Session Server | `version` в `apps/server/package.json` и соответствующая запись в `package-lock.json` |
| Companion | Поле `expo.version` в конфигурации Expo и `version` в `apps/mobile/package.json` и lock-файле, когда приложение войдёт в репозиторий |

`PROTOCOL_VERSION` повышается при несовместимом изменении формата обмена. `GENERATOR_VERSION`
меняется по правилам генератора, когда меняется результат того же seed. Обе версии обновляются
по своим правилам независимо от продуктовой версии. В релизных заметках укажите влияние на
совместимость устройств, сохранений и повторов по seed.
[ADR 0009](../architecture/adr/0009-protocol-schemas.md) ·
[ADR 0004](../architecture/adr/0004-determinism.md)

## Подготовка выпуска

1. Обновите продуктовые версии и npm lock-файл в релизном PR.
2. Перенесите записи из `Unreleased` в новый раздел вида `## [0.1.0] - YYYY-MM-DD` в
   [CHANGELOG.md](../../CHANGELOG.md). Сгруппируйте изменения по `Added`, `Changed`, `Deprecated`,
   `Removed`, `Fixed` и `Security`, если эти группы нужны. Оставьте пустую секцию `Unreleased`
   для следующих изменений. [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
3. Поставьте метку `release`. Проверка `Check release changelog` сравнит ветку PR с общей базой
   и потребует новый датированный заголовок версии в changelog.
4. После зелёного CI и ревью влейте PR по [правилам Git](git-workflow.md). Поставьте тег
   `v<версия>` на squash-коммит в `main`, соберите артефакты из этого тега и проверьте запуск.
5. Подготовьте запись GitHub Release по [шаблону](../../.github/RELEASE_TEMPLATE.md).
   Добавьте проверенные сборки и заполните раздел совместимости.
