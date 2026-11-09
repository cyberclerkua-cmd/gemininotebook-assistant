# Gemini Notebook Assistant

> Добавляйте веб-страницы, видео YouTube, комментарии и PDF в Google Gemini Notebook одним кликом.

**Gemini Notebook Assistant** — расширение для Google Chrome, которое расширяет возможности [Google Gemini Notebook](https://notebooklm.google.com). Оно позволяет быстро добавлять источники из браузера, парсить YouTube-комментарии, массово управлять источниками и синхронизировать файлы Google Drive — всё без необходимости вручную копировать ссылки.

![Chrome](https://img.shields.io/badge/Chrome-MV3-green) ![Version](https://img.shields.io/badge/version-3.3.9-blue) ![License](https://img.shields.io/badge/license-MIT-yellow)

Проверка и разработка: [TESTING.md](TESTING.md). Исправления и результаты проверки: [TEST_REPORT.md](TEST_REPORT.md).
Подготовка и обновление GitHub: [GITHUB_UPDATE.md](GITHUB_UPDATE.md). Описание выпуска: [RELEASE_NOTES.md](RELEASE_NOTES.md).

---

## 📋 Содержание

- [Возможности](#-возможности)
- [Установка](#-установка)
- [Структура проекта](#-структура-проекта)
- [Использование](#-использование)
  - [Главная](#главная)
  - [Парсеры](#парсеры)
  - [Очередь](#очередь)
  - [Источники](#источники)
  - [История](#история)
  - [Настройки](#настройки)
- [Горячие клавиши](#-горячие-клавиши)
- [Контекстное меню](#-контекстное-меню)
- [Плавающая панель на Gemini Notebook](#-плавающая-панель-на-notebooklm)
- [Поддержка нескольких аккаунтов](#-поддержка-нескольких-аккаунтов)
- [Локализация](#-локализация)
- [Технические детали](#-технические-детали)
- [Устранение неполадок](#-устранение-неполадок)

---

## ✨ Возможности

### Добавление источников
- **Добавить текущую страницу** — одним кликом отправить URL активной вкладки в выбранный блокнот
- **Сохранить как PDF** — захватить страницу целиком (с изображениями и стилями) как PDF и загрузить в Gemini Notebook
- **Добавить URL вручную** — ввести любой URL для добавления
- **Массовый импорт** — вставить список URL (по одному на строку) и добавить все разом
- **Импорт открытых вкладок** — выбрать нужные вкладки из списка всех открытых и отправить в блокнот

### Парсеры
- **YouTube-комментарии** — извлечь все комментарии с YouTube-видео (через InnerTube API), отформатировать в Markdown и добавить как текстовый источник
- **YouTube-плейлисты** — извлечь все ссылки на видео с текущей страницы YouTube
- **RSS / Sitemap** — обнаружить RSS-ленты на странице или указать URL вручную
- **Ссылки со страницы** — собрать все ссылки с любой веб-страницы

### Управление источниками
- **Просмотр источников** — список всех источников в блокноте с типами и иконками
- **Массовое удаление** — выбрать несколько источников и удалить за раз
- **Синхронизация Google Drive** — обновить все Google Docs/Sheets/Slides источники до актуальной версии
- **Экспорт** — выгрузить список источников в текстовый файл

### Плавающая панель на Gemini Notebook
- **Select All / Deselect All** — чекбоксы для каждого источника прямо на странице Gemini Notebook
- **Массовое удаление** — удалить выбранные источники через API
- **Sync Drive** — синхронизация Drive-файлов без открытия popup
- **Перетаскивание** — панель можно перемещать в любое место экрана (позиция сохраняется)

### Прочее
- **Очередь** — добавить URL в очередь для последовательной обработки с задержкой между запросами
- **История** — журнал всех действий с возможностью поиска
- **Горячие клавиши** — `Alt+Shift+N` (добавить страницу), `Alt+Shift+P` (сохранить PDF)
- **Контекстное меню** — правый клик → «Добавить в Gemini Notebook» / «Сохранить PDF»
- **Светлая / тёмная тема** — синхронизируется между popup и плавающей панелью
- **Русский и английский** язык интерфейса
- **Резервное копирование** — экспорт/импорт всех настроек в JSON

---

## 📦 Установка

### Способ 1: Установка из исходного кода (для разработчиков)

1. **Скачайте** или клонируйте репозиторий:
   ```bash
   git clone https://github.com/cyberclerkua-cmd/gemininotebook-assistant.git
   ```

2. **Откройте** страницу расширений Chrome:
   ```
   chrome://extensions/
   ```

3. **Включите** режим разработчика — переключатель в правом верхнем углу.

4. **Нажмите** «Загрузить распакованное расширение» (Load unpacked).

5. **Выберите** папку с расширением (где лежит `manifest.json`).

6. Расширение появится на панели инструментов. При необходимости закрепите его, нажав на значок 📌 в меню расширений.

### Способ 2: Установка из ZIP-архива

1. **Скачайте** ZIP-архив с расширением.
2. **Распакуйте** в удобную папку.
3. Выполните шаги 2–6 из Способа 1.

### После установки

1. **Войдите** в свой аккаунт Google на [notebooklm.google.com](https://notebooklm.google.com).
2. **Кликните** на иконку расширения — оно автоматически обнаружит ваши аккаунты и загрузит список блокнотов.
3. **Выберите блокнот** и начинайте добавлять источники!

> ⚠️ **Важно:** Расширение работает с вашей текущей сессией Google. Вы должны быть авторизованы в Gemini Notebook в том же браузере.

---

## 📁 Структура проекта

```
notebooklm-assistant/
├── manifest.json              # Манифест расширения (MV3)
├── background.js              # Service Worker: API, очередь, история, PDF
├── _locales/
│   ├── en/
│   │   └── messages.json      # Английская локализация
│   └── ru/
│       └── messages.json      # Русская локализация
├── lib/
│   ├── i18n.js                # Система интернационализации
│   ├── youtube-comments-api.js # YouTube InnerTube API клиент
│   └── comments-to-md.js     # Форматирование комментариев в Markdown
├── popup/
│   ├── popup.html             # Главное окно расширения
│   ├── popup.js               # Логика popup-интерфейса
│   ├── popup.css              # Стили popup
│   └── icons.css              # SVG-иконки (CSS mask-image)
├── content/
│   ├── notebooklm.js          # Content script для notebooklm.google.com
│   └── notebooklm.css         # Стили плавающей панели
├── app/
│   ├── app.html               # Страница импорта вкладок
│   └── app.js                 # Логика импорта вкладок
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Использование

### Главная

Основной экран для быстрых действий:

| Действие | Описание |
|----------|----------|
| **Аккаунт** | Выберите Google-аккаунт (если у вас несколько) |
| **Блокнот** | Выберите целевой блокнот из списка |
| **Создать блокнот** | Создать новый блокнот прямо из расширения |
| **Добавить страницу** | Добавить URL текущей вкладки как источник |
| **Сохранить PDF** | Захватить страницу как PDF и загрузить |
| **URL** | Ввести произвольный URL для добавления |
| **Массовый импорт** | Вставить список URL для пакетного добавления |
| **Импорт вкладок** | Открыть страницу выбора из открытых вкладок |

### Парсеры

#### YouTube-комментарии
1. Откройте YouTube-видео в отдельной вкладке.
2. Перейдите на вкладку **Парсеры** в расширении.
3. Настройте параметры:
   - **Сортировка**: лучшие комментарии / сначала новые
   - **Включить ответы**: парсить ответы на комментарии
   - **Макс. комментариев**: ограничить количество (0 = без ограничений)
4. Нажмите **Начать парсинг**.
5. Комментарии будут загружены через InnerTube API, отформатированы в Markdown и добавлены как текстовый источник.

#### YouTube-плейлисты и ссылки
- **Извлечь URL из вкладки** — находясь на странице YouTube-канала или плейлиста, извлеките все ссылки на видео.
- **Извлечь ссылки** — собрать все ссылки с любой веб-страницы.
- **RSS Auto-detect** — найти RSS/Atom ленты на текущей странице.

### Очередь

Очередь позволяет собрать URL для добавления, а затем обработать их разом:

1. Добавляйте URL в очередь из любого места (массовый импорт, контекстное меню, парсеры).
2. Перейдите на вкладку **Очередь** — увидите все ожидающие URL.
3. Нажмите **Обработать очередь** — URL будут добавлены в блокнот последовательно с задержкой (настраивается).

> Бейдж на иконке расширения показывает количество элементов в очереди.

### Источники

Вкладка для управления источниками выбранного блокнота:

- **Список** — все источники с типами (web, YouTube, PDF, Google Docs и т.д.)
- **Выбрать все** — отметить/снять все чекбоксы
- **Удалить выбранные** — массовое удаление через API
- **Синхр. Google Drive** — обновить Drive-источники до актуального содержимого
- **Экспорт** — скачать список источников как текстовый файл

### История

Журнал всех действий: добавления, удаления, ошибки. Поддерживает поиск. Хранится до 500 записей.

### Настройки

| Настройка | Описание |
|-----------|----------|
| **Тема** | Светлая / Тёмная |
| **Язык** | English / Русский |
| **Задержка** | Пауза между добавлениями в очереди (мс) |
| **Массовое удаление** | Включить чекбоксы и панель на странице NLM |
| **Синхр. Drive** | Показать кнопку Sync Drive на панели NLM |
| **Уведомления** | Показывать Chrome-уведомления |
| **Резервная копия** | Экспорт настроек, истории и очереди в JSON |
| **Восстановить** | Импорт настроек из JSON-файла |

---

## ⌨️ Горячие клавиши

| Комбинация | Действие |
|------------|----------|
| `Alt + Shift + N` | Добавить текущую страницу в очередь |
| `Alt + Shift + P` | Сохранить текущую страницу как PDF |

Горячие клавиши можно переназначить на странице `chrome://extensions/shortcuts`.

---

## 🖱️ Контекстное меню

Правый клик на странице или ссылке:

- **Добавить в Gemini Notebook** — добавить страницу/ссылку в очередь
- **Сохранить PDF в Gemini Notebook** — захватить страницу как PDF

---

## 🔲 Плавающая панель на Gemini Notebook

При открытии любого блокнота на `notebooklm.google.com` в правом нижнем углу появляется плавающая панель инструментов:

- **⠿ Drag handle** — захватите и перетащите панель в любое место экрана. Позиция сохраняется между сессиями.
- **Select all / Deselect all** — выделить или снять выделение со всех источников. У каждого источника появляется чекбокс при наведении.
- **Delete** — удалить выбранные источники (появляется при выделении хотя бы одного).
- **Sync Drive** — обновить все Google Drive-источники в блокноте.

Панель поддерживает светлую и тёмную тему, автоматически синхронизируясь с настройками расширения.

---

## 👥 Поддержка нескольких аккаунтов

Если вы авторизованы в нескольких Google-аккаунтах, расширение обнаружит их автоматически. Выберите нужный аккаунт в выпадающем списке на главной вкладке — список блокнотов обновится.

---

## 🌐 Локализация

Расширение поддерживает два языка:

- EN **English** (по умолчанию)
- RU **Русский**

Переключение — в **Настройки → Язык**. Применяется к интерфейсу popup (статические надписи) и странице импорта вкладок (`app.html`). Заголовки в Markdown-выводе комментариев YouTube выбираются по языку отдельно от `_locales` (см. `lib/comments-to-md.js`).

---

## 🔧 Технические детали

### API
Расширение взаимодействует с Gemini Notebook через **reverse-engineered RPC API** (`batchexecute`). Публичного API у Gemini Notebook нет. Используемые RPC-методы:

| RPC ID | Назначение |
|--------|-----------|
| `wXbhsf` | Список блокнотов |
| `CCqFvf` | Создание блокнота |
| `izAoDd` | Добавление источников (URL, текст, YouTube) |
| `rLM1Ne` | Получение деталей блокнота и списка источников |
| `tGMBJ` | Удаление источников |
| `o4cbdc` | Регистрация PDF-источника |
| `yR9Yof` | Проверка актуальности Drive-источника |
| `FLmJqe` | Синхронизация Drive-источника |

### YouTube-комментарии
Парсинг комментариев использует **YouTube InnerTube API** — внутренний API YouTube, вызываемый в контексте YouTube-вкладки (`chrome.scripting.executeScript` с `world: 'MAIN'`). Это позволяет:
- Использовать авторизацию пользователя без запроса API-ключей
- Обходить ограничения YouTube Data API v3 (лимиты квот)
- Получать все комментарии, включая ответы

### PDF-захват
Для создания PDF используется `chrome.debugger` API с протоколом Chrome DevTools (`Page.printToPDF`). Затем файл загружается через SCOTTY upload protocol Gemini Notebook.

### Хранение данных
- `chrome.storage.sync` — настройки (тема, язык, переключатели)
- `chrome.storage.local` — очередь, история, позиция панели, выбранный блокнот

### Permissions

| Permission | Зачем |
|-----------|-------|
| `tabs` | Получение URL и заголовков вкладок |
| `storage` | Сохранение настроек, очереди, истории |
| `activeTab` | Доступ к активной вкладке для добавления |
| `scripting` | Внедрение скриптов для парсинга YouTube |
| `contextMenus` | Контекстное меню «Добавить в Gemini Notebook» |
| `debugger` | Захват страницы как PDF |
| `notifications` | Chrome-уведомления о действиях |
| `alarms` | Для отказоустойчивой обработки очереди (crash-safe queue) |
| `offscreen` | Разбор RSS, Atom и Sitemap через XML DOM в скрытом документе расширения |
| `host_permissions`: `https://notebooklm.google.com/*` | Доступ к API Gemini Notebook |
| `host_permissions`: `https://www.youtube.com/*` | Парсинг комментариев YouTube |
| `host_permissions`: `https://accounts.google.com/*` | Обнаружение Google-аккаунтов |
| `optional_host_permissions`: `http://*/*`, `https://*/*` | Загрузка RSS-лент (запрашивается динамически для каждого источника) |

---

## ❓ Устранение неполадок

### «Extension context invalidated»
Расширение было обновлено или перезагружено. Появится красный баннер вверху страницы — **кликните** по нему для перезагрузки.

### «Could not extract NLM tokens. Are you logged in?»
Убедитесь, что вы авторизованы на [notebooklm.google.com](https://notebooklm.google.com) в том же браузере.

### Блокнот не появляется в списке
- Нажмите кнопку **🔄 обновить** рядом со списком блокнотов.
- Если у вас несколько аккаунтов — убедитесь, что выбран правильный.

### Страница не добавляется в блокнот
- Убедитесь, что выбран блокнот (не «Select notebook...»).
- Проверьте, что URL начинается с `http://` или `https://`.
- Некоторые URL могут быть заблокированы Gemini Notebook (например, localhost).

### YouTube-комментарии не парсятся
- Убедитесь, что YouTube-видео открыто в **отдельной вкладке**.
- Комментарии должны быть **включены** на видео.
- Попробуйте **прокрутить** страницу до секции комментариев перед парсингом.

### PDF не сохраняется
- Chrome может запросить разрешение на использование отладчика — **разрешите**.
- PDF-захват не работает на служебных страницах Chrome (`chrome://`, `chrome-extension://`).

### Плавающая панель не появляется
- Панель отображается только **внутри блокнота** (URL вида `notebooklm.google.com/notebook/...`).
- Проверьте, что в настройках включена опция «Массовое удаление в NLM».
- Перезагрузите страницу Gemini Notebook.

### RSS-лента не загружается
- При первом добавлении RSS расширение запросит разрешение на доступ к соответствующему домену — **разрешите**.
- Убедитесь, что URL начинается с `http://` или `https://` и отдаёт корректный RSS/Atom/Sitemap XML.
- Разрешения можно проверить на `chrome://extensions/` → «Подробнее» → «Разрешения сайтов».

### Активный аккаунт сбрасывается после перезапуска браузера
- В v3.1.0 выбор активного аккаунта сохраняется в `chrome.storage.sync` и восстанавливается при запуске service worker'а.
- Если проблема осталась — убедитесь, что Chrome Sync не отключён в настройках браузера.

---

## 📄 Лицензия

MIT License. Свободное использование, модификация и распространение.

---

**Gemini Notebook Assistant** не является официальным продуктом Google. Google, Gemini Notebook, YouTube и Google Drive — товарные знаки Google LLC.


# Gemini Notebook Assistant

> Add web pages, YouTube videos, comments, and PDFs to Google Gemini Notebook in one click.

**Gemini Notebook Assistant** is a Google Chrome extension that supercharges [Google Gemini Notebook](https://notebooklm.google.com). It lets you quickly add sources from your browser, parse YouTube comments, bulk-manage sources, and sync Google Drive files — all without manually copying links.

![Chrome](https://img.shields.io/badge/Chrome-MV3-green) ![Version](https://img.shields.io/badge/version-3.3.9-blue) ![License](https://img.shields.io/badge/license-MIT-yellow)

Development checks: [TESTING.md](TESTING.md). Fixes and verification results: [TEST_REPORT.md](TEST_REPORT.md).
Packaging and GitHub updates: [GITHUB_UPDATE.md](GITHUB_UPDATE.md). Release description: [RELEASE_NOTES.md](RELEASE_NOTES.md).

---

## 📋 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Project Structure](#-project-structure)
- [Usage](#-usage)
  - [Home](#home)
  - [Parsers](#parsers)
  - [Queue](#queue)
  - [Sources](#sources)
  - [History](#history)
  - [Settings](#settings)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [Context Menu](#-context-menu)
- [Floating Toolbar on Gemini Notebook](#-floating-toolbar-on-notebooklm)
- [Multiple Account Support](#-multiple-account-support)
- [Localization](#-localization)
- [Technical Details](#-technical-details)
- [Troubleshooting](#-troubleshooting)

---

## ✨ Features

### Adding Sources
- **Add Current Page** — send the active tab's URL to the selected notebook with one click
- **Save as PDF** — capture the full page (with images and styles) as a PDF and upload it to Gemini Notebook
- **Add URL Manually** — enter any URL to add as a source
- **Bulk Import** — paste a list of URLs (one per line) and add them all at once
- **Import Open Tabs** — pick tabs from a list of all open tabs and send them to a notebook

### Parsers
- **YouTube Comments** — extract all comments from a YouTube video (via InnerTube API), format them as Markdown, and add as a text source
- **YouTube Playlists** — extract all video links from the current YouTube page
- **RSS / Sitemap** — auto-detect RSS feeds on a page or enter a URL manually
- **Page Links** — collect all links from any web page

### Source Management
- **View Sources** — list all sources in a notebook with types and icons
- **Bulk Delete** — select multiple sources and delete them at once
- **Google Drive Sync** — update all Google Docs/Sheets/Slides sources to their latest version
- **Export** — download the source list as a text file

### Floating Toolbar on Gemini Notebook
- **Select All / Deselect All** — checkboxes for every source right on the Gemini Notebook page
- **Bulk Delete** — delete selected sources via the API
- **Sync Drive** — sync Drive files without opening the popup
- **Drag & Drop** — move the toolbar anywhere on screen (position is saved between sessions)

### More
- **Queue** — add URLs to a queue for sequential processing with a configurable delay between requests
- **History** — a log of all actions with search support
- **Keyboard Shortcuts** — `Alt+Shift+N` (add page), `Alt+Shift+P` (save as PDF)
- **Context Menu** — right-click → "Add to Gemini Notebook" / "Save PDF"
- **Light / Dark Theme** — syncs between the popup and the floating toolbar
- **English and Russian** interface languages
- **Backup & Restore** — export/import all settings as JSON

---

## 📦 Installation

### Method 1: From Source (for developers)

1. **Download** or clone the repository:
   ```bash
   git clone https://github.com/cyberclerkua-cmd/gemininotebook-assistant.git
   ```

2. **Open** the Chrome extensions page:
   ```
   chrome://extensions/
   ```

3. **Enable** Developer Mode — toggle in the top-right corner.

4. **Click** "Load unpacked".

5. **Select** the extension folder (the one containing `manifest.json`).

6. The extension will appear in the toolbar. Pin it if needed by clicking the 📌 icon in the extensions menu.

### Method 2: From a ZIP Archive

1. **Download** the ZIP archive with the extension.
2. **Extract** it to a convenient folder.
3. Follow steps 2–6 from Method 1.

### After Installation

1. **Sign in** to your Google account at [notebooklm.google.com](https://notebooklm.google.com).
2. **Click** the extension icon — it will automatically detect your accounts and load your notebooks.
3. **Select a notebook** and start adding sources!

> ⚠️ **Important:** The extension uses your current Google session. You must be signed in to Gemini Notebook in the same browser.

---

## 📁 Project Structure

```
notebooklm-assistant/
├── manifest.json              # Extension manifest (MV3)
├── background.js              # Service Worker: API, queue, history, PDF
├── _locales/
│   ├── en/
│   │   └── messages.json      # English localization
│   └── ru/
│       └── messages.json      # Russian localization
├── lib/
│   ├── i18n.js                # Internationalization system
│   ├── youtube-comments-api.js # YouTube InnerTube API client
│   └── comments-to-md.js     # Comment-to-Markdown formatter
├── popup/
│   ├── popup.html             # Main extension window
│   ├── popup.js               # Popup UI logic
│   ├── popup.css              # Popup styles
│   └── icons.css              # SVG icons (CSS mask-image)
├── content/
│   ├── notebooklm.js          # Content script for notebooklm.google.com
│   └── notebooklm.css         # Floating toolbar styles
├── app/
│   ├── app.html               # Tab import page
│   └── app.js                 # Tab import logic
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Usage

### Home

The main screen for quick actions:

| Action | Description |
|--------|-------------|
| **Account** | Select a Google account (if you have multiple) |
| **Notebook** | Select the target notebook from the list |
| **Create Notebook** | Create a new notebook directly from the extension |
| **Add Page** | Add the current tab's URL as a source |
| **Save PDF** | Capture the page as a PDF and upload it |
| **URL** | Enter an arbitrary URL to add |
| **Bulk Import** | Paste a list of URLs for batch adding |
| **Import Tabs** | Open a page to select from all open tabs |

### Parsers

#### YouTube Comments
1. Open a YouTube video in a separate tab.
2. Go to the **Parsers** tab in the extension.
3. Configure the settings:
   - **Sort by**: Top comments / Newest first
   - **Include replies**: parse reply threads
   - **Max comments**: limit the count (0 = unlimited)
4. Click **Start parsing**.
5. Comments will be fetched via the InnerTube API, formatted as Markdown, and added as a text source.

#### YouTube Playlists & Links
- **Extract URLs from tab** — while on a YouTube channel or playlist page, extract all video links.
- **Extract links** — collect all links from any web page.
- **RSS Auto-detect** — find RSS/Atom feeds on the current page.

### Queue

The queue lets you collect URLs first, then process them all at once:

1. Add URLs to the queue from anywhere (bulk import, context menu, parsers).
2. Go to the **Queue** tab — you'll see all pending URLs.
3. Click **Process Queue** — URLs will be added to the notebook sequentially with a delay (configurable).

> The badge on the extension icon shows the number of items in the queue.

### Sources

A tab for managing sources in the selected notebook:

- **List** — all sources with types (web, YouTube, PDF, Google Docs, etc.)
- **Select All** — check/uncheck all checkboxes
- **Delete Selected** — bulk delete via the API
- **Sync Google Drive** — update Drive sources to their latest content
- **Export** — download the source list as a text file

### History

A log of all actions: additions, deletions, errors. Supports search. Stores up to 500 entries.

### Settings

| Setting | Description |
|---------|-------------|
| **Theme** | Light / Dark |
| **Language** | English / Russian |
| **Delay** | Pause between queue additions (ms) |
| **Bulk Delete** | Enable checkboxes and toolbar on the NLM page |
| **Sync Drive** | Show Sync Drive button on the NLM toolbar |
| **Notifications** | Show Chrome notifications |
| **Backup** | Export settings, history, and queue to JSON |
| **Restore** | Import settings from a JSON file |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt + Shift + N` | Add current page to the queue |
| `Alt + Shift + P` | Save current page as PDF |

Shortcuts can be reassigned at `chrome://extensions/shortcuts`.

---

## 🖱️ Context Menu

Right-click on a page or a link:

- **Add to Gemini Notebook** — add the page/link to the queue
- **Save as PDF to Gemini Notebook** — capture the page as a PDF

---

## 🔲 Floating Toolbar on Gemini Notebook

When you open any notebook on `notebooklm.google.com`, a floating toolbar appears in the bottom-right corner:

- **⠿ Drag handle** — grab and drag the toolbar anywhere on screen. Position is saved between sessions.
- **Select all / Deselect all** — check or uncheck all sources. Each source gets a checkbox that appears on hover.
- **Delete** — delete selected sources (appears when at least one is selected).
- **Sync Drive** — update all Google Drive sources in the notebook.

The toolbar supports light and dark themes, automatically syncing with the extension settings.

---

## 👥 Multiple Account Support

If you're signed in to multiple Google accounts, the extension will detect them automatically. Select the desired account from the dropdown on the Home tab — the notebook list will update accordingly.

---

## 🌐 Localization

The extension supports two languages:

- 🇬🇧 **English** (default)
- 🇷🇺 **Russian**

Switch in **Settings → Language**. Applies to the popup UI (static labels) and the tab-import page (`app.html`). YouTube comment Markdown headers are language-aware through a separate mechanism (see `lib/comments-to-md.js`), not through the `_locales` files.

---

## 🔧 Technical Details

### API
The extension communicates with Gemini Notebook through a **reverse-engineered RPC API** (`batchexecute`). Gemini Notebook does not have a public API. RPC methods used:

| RPC ID | Purpose |
|--------|---------|
| `wXbhsf` | List notebooks |
| `CCqFvf` | Create notebook |
| `izAoDd` | Add sources (URL, text, YouTube) |
| `rLM1Ne` | Get notebook details and source list |
| `tGMBJ` | Delete sources |
| `o4cbdc` | Register PDF source |
| `yR9Yof` | Check Drive source freshness |
| `FLmJqe` | Sync Drive source |

### YouTube Comments
Comment parsing uses the **YouTube InnerTube API** — YouTube's internal API, executed in the YouTube tab context (`chrome.scripting.executeScript` with `world: 'MAIN'`). This allows:
- Using the user's existing authentication without requiring API keys
- Bypassing YouTube Data API v3 quota limits
- Fetching all comments, including reply threads

### PDF Capture
PDF generation uses the `chrome.debugger` API with the Chrome DevTools Protocol (`Page.printToPDF`). The file is then uploaded via Gemini Notebook's SCOTTY upload protocol.

### Data Storage
- `chrome.storage.sync` — settings (theme, language, toggles)
- `chrome.storage.local` — queue, history, toolbar position, selected notebook

### Permissions

| Permission | Why |
|-----------|-----|
| `tabs` | Access tab URLs and titles |
| `storage` | Save settings, queue, and history |
| `activeTab` | Access the active tab for adding sources |
| `scripting` | Inject scripts for YouTube comment parsing |
| `contextMenus` | "Add to Gemini Notebook" context menu |
| `debugger` | Capture pages as PDF |
| `notifications` | Chrome notifications for actions |
| `alarms` | For crash-safe queue processing |
| `offscreen` | Parse RSS, Atom and Sitemap XML in an extension-owned DOM document |
| `host_permissions`: `https://notebooklm.google.com/*` | Access to the Gemini Notebook API |
| `host_permissions`: `https://www.youtube.com/*` | YouTube comment parsing |
| `host_permissions`: `https://accounts.google.com/*` | Google account detection |
| `optional_host_permissions`: `http://*/*`, `https://*/*` | RSS feed fetching (requested dynamically per-origin) |

---

## ❓ Troubleshooting

### "Extension context invalidated"
The extension was updated or reloaded. A red banner will appear at the top of the page — **click it** to reload.

### "Could not extract NLM tokens. Are you logged in?"
Make sure you are signed in to [notebooklm.google.com](https://notebooklm.google.com) in the same browser.

### Notebook doesn't appear in the list
- Click the **🔄 refresh** button next to the notebook dropdown.
- If you have multiple accounts, make sure the correct one is selected.

### Page isn't added to the notebook
- Make sure a notebook is selected (not "Select notebook...").
- Check that the URL starts with `http://` or `https://`.
- Some URLs may be blocked by Gemini Notebook (e.g., localhost).

### YouTube comments aren't parsed
- Make sure the YouTube video is open in a **separate tab**.
- Comments must be **enabled** on the video.
- Try **scrolling down** to the comments section before parsing.

### PDF won't save
- Chrome may ask for permission to use the debugger — **allow it**.
- PDF capture does not work on Chrome internal pages (`chrome://`, `chrome-extension://`).

### Floating toolbar doesn't appear
- The toolbar only appears **inside a notebook** (URL like `notebooklm.google.com/notebook/...`).
- Check that "Enable bulk delete on NLM" is turned on in Settings.
- Reload the Gemini Notebook page.

### RSS feed doesn't load
- The first time you add an RSS feed, the extension asks for per-origin host permission — **allow it**.
- Make sure the URL starts with `http://` or `https://` and returns valid RSS/Atom/Sitemap XML.
- You can review permissions at `chrome://extensions/` → "Details" → "Site permissions".

### Active account resets after browser restart
- In v3.1.0 the active account choice is persisted to `chrome.storage.sync` and restored when the service worker starts.
- If the problem persists, make sure Chrome Sync is not disabled in the browser settings.

---

## 📄 License

MIT License. Free to use, modify, and distribute.

---

**Gemini Notebook Assistant** is not an official Google product. Google, Gemini Notebook, YouTube, and Google Drive are trademarks of Google LLC.

---

## 📋 Changelog

### v3.3.9

- Последний выбор аккаунта имеет приоритет над запоздавшими ответами авторизации; неудачное переключение восстанавливает подтверждённый аккаунт.
- Перед отправкой элемента очереди сохраняется снимок существующих источников. При потере ответа результат сверяется с блокнотом; неподтверждённый запрос автоматически не отправляется повторно.
- Новая очередь после отмены предыдущей продолжает работу после завершения текущего RPC, без ожидания alarm watchdog.
- Массовый импорт возвращает статусы каждого URL, сохраняет историю успешных добавлений и позволяет повторять только неудачные и ещё не отправленные элементы.
- Добавлены регрессионные проверки этих сценариев, включая задержанные ответы, перезапуск worker и сохранение состояния в резервной копии.

### v3.3.8

- Исправлены обработка RPC-ошибок и единый формат сообщений между интерфейсами и service worker.
- Изолированы токены аккаунтов; выбранные блокноты сохраняются отдельно для каждого аккаунта.
- Очередь сохраняется между перезапусками, использует стабильные ID, реальные статусы и три попытки обработки.
- Исправлены PDF-команды, актуальный формат регистрации PDF и определение актуальности Google Drive.
- Исправлены сортировка, лимиты, отмена и постраничная загрузка ответов YouTube.
- Реализован XML-разбор RSS/Atom/Sitemap и индексов Sitemap через offscreen-документ.
- Исправлены сопоставление источников при удалении, восстановление настроек, локализация и импорт вкладок.
- Добавлены автоматические проверки и браузерные тесты. Результаты сквозных проверок Google описаны в [TEST_REPORT.md](TEST_REPORT.md).

При установке этой версии перезагрузите расширение и открытые страницы Gemini Notebook.

### v3.3.7

**Сервис обновился: NotebookLM → Gemini Notebook**

- Обновлено: все надписи "NotebookLM" заменены на "Gemini Notebook" во всём расширении
  (название расширения, описание, контекстное меню, уведомления, локали RU/EN, README)
- Обновлено: LICENSE — copyright holder изменён на "Gemini Notebook Assistant Contributors"
- Сохранено: API-домен `notebooklm.google.com` остаётся без изменений (сервис
  переехал на новый маркетинговый домен `notebooklm.google`, но backend API
  продолжает работать на старом домене — подтверждено 2025-07)
- Сохранено: все RPC-вызовы (`izAoDd`, `wXbhsf`, `CCqFvf`, и т.д.) без изменений
- Сохранено: формат источников (text/URL/YouTube) без изменений — исправлен в v3.1.0
- Проверено: все функции расширения работают (syntax check, формат verification)

**Что не изменилось:**
- Домен `notebooklm.google.com` — это по-прежнему адрес приложения (требует Google-аккаунта)
- API endpoints (`/_/LabsTailwindUi/data/batchexecute`) — без изменений
- RPC IDs и форматы payload — без изменений
- Разрешения (permissions) — без изменений


### v3.1.0

#### Fixed
- MV3 service worker state persistence — the active Google account is now persisted to `chrome.storage.sync` and restored when the service worker restarts (no longer silently resets to account 0).
- Context menu duplicate-ID error on extension update — `chrome.contextMenus.removeAll()` is now called before `create()` in `chrome.runtime.onInstalled`.
- Queue processing is now crash-safe with retry logic via `chrome.alarms`; errored items are marked and retained for retry instead of being dropped.
- XSS vulnerability in popup `escapeHtml` — single and double quotes are now escaped (`"` → `&quot;`, `'` → `&#39;`).
- XSS in `comments-to-md.js` `_sanitize` — it no longer decodes `&lt;` / `&gt;` back to raw `<` / `>`; HTML entities are kept encoded.
- Content script delete now uses exact source IDs (read from the DOM) instead of fuzzy title matching — wrong-source deletes are no longer possible.
- Multi-account selection now persists across popup opens and across service-worker restarts.
- RSS parser fully implemented — `parse-rss` command fetches the feed and parses RSS 2.0 / Atom / Sitemap XML; popup requests per-origin host permission before fetching.
- YouTube comments reply extraction — added a `commentViewModel` handler for the new 2024-2025 InnerTube format (replies were being silently dropped).
- `generatePdf` now has a 30-second timeout via `Promise.race` (no more infinite debugger banner if a page is unresponsive).
- `chrome.notifications.create` now respects the `settingsNotifications` toggle.
- SPA navigation in the content script is debounced — was triggering up to 5 overlapping `setup()` cycles per navigation; now collapsed to 1.
- Floating toolbar now has Close and Minimize buttons (CSS class `.ms-close` is now actually rendered).
- `app/app.html` is now localized via `lib/i18n.js` (previously hardcoded English-only).
- Hardened `escapeHtml`, added `try/catch`, and consistent error handling across popup, app, background, and content script.

#### Added
- `LICENSE` file (MIT License, copyright 2025 Gemini Notebook Assistant Contributors).
- Per-origin host permission request for RSS feeds via `chrome.permissions.request()` (no blanket `<all_urls>` access).
- `alarms` permission to the manifest for crash-safe queue scheduling.
- `optional_host_permissions` (`http://*/*`, `https://*/*`) for opt-in RSS feed fetching.
- `minimum_chrome_version: 116` to the manifest.
- 27 new i18n keys in both `_locales/en/messages.json` and `_locales/ru/messages.json` (toolbar buttons, app page, RSS, retry/timeout, PDF status, etc.).
- `tabOrganize` EN locale value corrected from `"Organize"` to `"Sources"` (now matches the README and the RU `"Источники"`).
- `selectAll` EN locale value corrected from `"Select all"` to `"Select All"` (casing aligned with `deselectAll` and the rest of the toolbar buttons).

---

**Gemini Notebook Assistant** не является официальным продуктом Google. Google, Gemini Notebook, YouTube и Google Drive — товарные знаки Google LLC.
