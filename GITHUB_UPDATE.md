# Обновление GitHub до версии 3.3.9

Репозиторий: https://github.com/cyberclerkua-cmd/gemininotebook-assistant

## Готовые файлы

После `npm run package` папка `dist/` содержит:

| Файл или папка | Назначение |
|---|---|
| `github-update/` | Файлы для обновления исходников в корне GitHub-репозитория |
| `gemininotebook-assistant-3.3.9-source.zip` | ZIP с тем же набором исходников |
| `extension/` | Распакованная установочная версия с `manifest.json` в корне |
| `gemininotebook-assistant-3.3.9.zip` | Установочный архив для GitHub Releases |
| `RELEASE_NOTES.md` | Текст описания выпуска |
| `SHA256SUMS.txt` | SHA-256 обоих ZIP-архивов |

## Вариант 1 — загрузка через сайт GitHub

1. Откройте репозиторий и выберите **Add file → Upload files**.
2. Перетащите **содержимое `dist/github-update/`**: файлы и папки, включая `.gitignore`, должны попасть в корень репозитория рядом с `manifest.json`.
3. Введите сообщение коммита `Update to 3.3.9` и сохраните изменения. При необходимости используйте отдельную ветку и Pull Request.

GitHub не распаковывает загруженный ZIP в исходники. Архив `*-source.zip` нужно предварительно распаковать либо загрузить его как файл выпуска в разделе Releases.

## Вариант 2 — Git из текущей рабочей копии

Выполните из папки проекта:

```sh
git status --short
git diff
git log --oneline -10
git add .gitignore README.md LICENSE manifest.json background.js _locales app content popup icons lib offscreen package.json package-lock.json playwright.config.cjs scripts tests release TESTING.md TEST_REPORT.md GITHUB_UPDATE.md RELEASE_NOTES.md
git diff --cached --check
git diff --cached --stat
git commit -m "Update to 3.3.9"
git push origin main
```

Если основная ветка защищена, создайте рабочую ветку перед коммитом, отправьте её на GitHub и откройте Pull Request.
Артефакты `dist/`, зависимости `node_modules/` и локальные отчёты тестов исключены через `.gitignore`.

## Создание GitHub Release

После обновления исходников:

1. Откройте **Releases → Draft a new release**.
2. Создайте тег **`v3.3.9`** на обновлённом коммите.
3. Название выпуска: **Gemini Notebook Assistant 3.3.9**.
4. Вставьте текст из `RELEASE_NOTES.md`.
5. Приложите установочный ZIP и `SHA256SUMS.txt`. При желании приложите подготовленный ZIP исходников.
6. Опубликуйте выпуск.

## Повторная подготовка

```sh
npm ci
npx playwright install chromium
npm test
npm run package
```

Проверка контрольной суммы в PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 "dist\gemininotebook-assistant-3.3.9.zip"
```

При неизменных входных файлах упаковщик создаёт одинаковые байты архивов и проверяет их содержимое после сжатия.
