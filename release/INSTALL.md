# Gemini Notebook Assistant — установка и обновление

## Установка

1. Распакуйте ZIP в постоянную папку. В выбранной папке должен находиться `manifest.json`.
2. Откройте `chrome://extensions/` и включите «Режим разработчика».
3. Нажмите «Загрузить распакованное расширение» и выберите эту папку.
4. Войдите в Google на https://notebook.google.com/.
5. Откройте расширение, выберите аккаунт и блокнот.

## Обновление установленной распакованной версии

1. Распакуйте новую версию поверх файлов в той же папке, из которой уже загружено расширение.
2. На `chrome://extensions/` нажмите кнопку перезагрузки карточки расширения.
3. Обновите открытые страницы Gemini Notebook и YouTube.

Использование прежней папки сохраняет идентификатор распакованного расширения и связанные с ним настройки браузера.

При импорте с неопределённым сетевым результатом расширение сначала проверяет блокнот. Уже отправленный запрос автоматически не повторяется, чтобы не создать дубликат.

Репозиторий и документация: https://github.com/cyberclerkua-cmd/gemininotebook-assistant

---

## English

Extract the ZIP, open `chrome://extensions/`, enable Developer Mode and use **Load unpacked** to select the folder containing `manifest.json`.
To update an unpacked installation, replace the files in its existing folder, reload the extension and refresh open Notebook/YouTube pages.
Sign in at https://notebook.google.com/ and select an account and notebook in the extension.
