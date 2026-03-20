<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC-RU Banner" width="680"/>
</p>

<p align="center">
  Интерактивные занятия с ИИ-преподавателем и озвучкой — в один клик
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=flat-square" alt="License: AGPL-3.0"/></a>
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
</p>

<p align="center">
  <b>Русский</b> | <a href="./README-en.md">English</a> | <a href="./README-zh.md">简体中文</a>
</p>

---

## 🎯 Что это

**OpenMAIC-RU** — русскоязычный форк [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) (Open Multi-Agent Interactive Classroom) от Университета Цинхуа.

Платформа превращает любую тему или документ в полноценное интерактивное занятие: ИИ-преподаватель ведёт урок, рисует на доске, задаёт вопросы, а ИИ-одноклассники участвуют в обсуждении. Всё это — со слайдами, тестами, симуляциями и озвучкой на русском языке.

### Отличия от оригинала

- 🇷🇺 Полная русская локализация интерфейса (ru-RU)
- 📝 Генерация уроков на русском языке
- 🎤 **Edge TTS** для бесплатной русской озвучки (голоса Светлана / Дмитрий), не требует API-ключей
- 🔤 Автоматическая нормализация аббревиатур для корректного произношения (ИИ → «искусственный интеллект», т.е., т.д. и др.)
- 🌐 Автодетект русского языка из настроек браузера

---

## 🚀 Быстрый старт

### Требования

- **Node.js** >= 18
- **pnpm** >= 10
- **edge-tts** (для озвучки): `pip install edge-tts`

### 1. Клонирование и установка

```bash
git clone https://github.com/your-org/OpenMAIC-RU.git
cd OpenMAIC-RU
pnpm install
```

### 2. Настройка

```bash
cp .env.example .env.local
```

Укажите хотя бы один LLM-провайдер. Рекомендуем начать с бесплатного **Xiaomi MiMo**:

```env
# Xiaomi MiMo (бесплатно, без лимитов)
MIMO_API_KEY=ваш-ключ
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
```

Также поддерживаются: **Google Gemini**, **DeepSeek**, **OpenAI**, **Anthropic** и любой OpenAI-compatible API.

### 3. Запуск

```bash
pnpm dev
```

Откройте **http://localhost:3000** и начните учиться!

### 4. Продакшен-сборка

```bash
pnpm build && pnpm start
```

---

## 🎤 Настройка TTS (озвучка)

Edge TTS установлен по умолчанию и работает сразу — без API-ключей и регистрации.

| Голос | Язык | Пол |
|-------|------|-----|
| `ru-RU-SvetlanaNeural` | Русский | Женский (по умолчанию) |
| `ru-RU-DmitryNeural` | Русский | Мужской |
| `zh-CN-XiaoxiaoNeural` | Китайский | Женский |
| `en-US-JennyNeural` | Английский | Женский |

Переключить голос и провайдер можно в **Настройки → TTS**.

Также поддерживаются: OpenAI TTS, Azure TTS, GLM TTS, Qwen TTS (требуют API-ключей).

---

## ✨ Возможности

- 🎓 **Генерация урока в один клик** — опишите тему или загрузите документ, ИИ построит полный урок за минуты
- 🤖 **Мульти-агентный класс** — ИИ-преподаватель и ИИ-одноклассники ведут обсуждение в реальном времени
- 📊 **Слайды, тесты, симуляции, PBL** — автоматическая генерация интерактивного контента и проектного обучения
- ✏️ **Доска и озвучка** — агенты рисуют диаграммы, пишут формулы и объясняют вслух
- 📦 **Экспорт** — скачивайте готовый урок в PPTX или HTML
- 🌙 **Тёмная тема** — для комфортных ночных занятий

---

## 💡 Примеры использования

Просто введите тему на главной странице — ИИ сгенерирует урок:

- «Научи меня Python с нуля за 30 минут»
- «Объясни квантовую механику простыми словами»
- «Как работает блокчейн и смарт-контракты»
- «Подготовка к ЕГЭ по математике: производные»
- «Основы сетевой безопасности и модель OSI»

---

## 🐳 Docker

```bash
cp .env.example .env.local
# Отредактируйте .env.local — укажите API-ключи
docker compose up --build
```

---

## 🔧 Структура проекта

```
OpenMAIC-RU/
├── app/                    # Next.js App Router
│   ├── api/                #   Серверные API (~18 эндпоинтов)
│   ├── classroom/[id]/     #   Страница урока
│   └── page.tsx            #   Главная (ввод темы)
├── lib/                    # Бизнес-логика
│   ├── generation/         #   Генерация уроков (план → контент)
│   ├── orchestration/      #   Мульти-агентная оркестрация (LangGraph)
│   ├── audio/              #   TTS и ASR провайдеры
│   ├── i18n/               #   Локализация (zh-CN, en-US, ru-RU)
│   └── ...
├── components/             # React-компоненты
│   ├── slide-renderer/     #   Рендер слайдов
│   ├── scene-renderers/    #   Тесты, симуляции, PBL
│   ├── settings/           #   Панель настроек
│   └── ...
└── public/                 # Статика (логотипы, аватары)
```

---

## 📄 Лицензия

Проект распространяется под лицензией [GNU Affero General Public License v3.0](LICENSE).

Оригинальный проект: [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) — Университет Цинхуа.

---

## 🙏 Благодарности

- [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) — оригинальная платформа
- [Microsoft Edge TTS](https://github.com/rany2/edge-tts) — бесплатный движок озвучки
- [Xiaomi MiMo](https://github.com/XiaomiBrowser/mimo-free-tts) — бесплатная LLM-модель
