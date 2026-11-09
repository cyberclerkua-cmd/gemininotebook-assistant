# Gemini Notebook Assistant 3.3.9

Обновление надёжности импорта и управления источниками, включающее исправления версий 3.3.8 и 3.3.9.

## Основные изменения

- Исправлены обработка ошибок Google RPC и актуальные форматы ответов PDF и Google Drive.
- Последний выбор аккаунта имеет приоритет над запоздавшими ответами авторизации.
- Очередь сохраняется между перезапусками; после потери ответа сверяет результат с блокнотом вместо повторного POST.
- Отмена и запуск новой очереди больше не требуют ожидания минутного watchdog.
- Массовый импорт показывает результаты по каждому URL и оставляет для повтора только ошибочные и неотправленные элементы.
- Исправлены определение источников при удалении, YouTube-комментарии, RSS/Atom/Sitemap, настройки, резервные копии и импорт вкладок.
- Добавлены автоматические регрессионные проверки и воспроизводимая упаковка `npm run package`.

## Файлы выпуска

- `gemininotebook-assistant-3.3.9.zip` — готовое расширение для распаковки и загрузки в Chrome.
- `gemininotebook-assistant-3.3.9-source.zip` — исходники, тесты, документация и инструменты разработки.
- `SHA256SUMS.txt` — контрольные суммы архивов.

## Установка и обновление

Распакуйте архив расширения. Откройте `chrome://extensions/`, включите режим разработчика и выберите «Загрузить распакованное расширение».
Для обновления замените файлы в прежней папке расширения, перезагрузите его карточку и обновите открытые страницы Gemini Notebook.

Добавлено разрешение `offscreen`: оно используется для разбора XML лент RSS, Atom и Sitemap.
Исход записи после сетевого обрыва может оставаться неопределённым; в этом случае повторная обработка проверяет блокнот и не дублирует запрос автоматически.

Результаты и границы тестирования: [TEST_REPORT.md](https://github.com/cyberclerkua-cmd/gemininotebook-assistant/blob/v3.3.9/TEST_REPORT.md). Команды разработчика: [TESTING.md](https://github.com/cyberclerkua-cmd/gemininotebook-assistant/blob/v3.3.9/TESTING.md).

## English summary

This release fixes account-switch races, duplicate imports after lost responses, queue restarts, partial bulk-import reporting, current PDF/Drive RPC formats, source identification, YouTube parsing and feed imports.
The extension ZIP is ready to extract and load through Chrome's Developer Mode. The source ZIP includes tests and development tools. See `SHA256SUMS.txt` for archive checksums.
