# OpenMAIC-RU — рабочий контракт для Claude Code

## Git workflow

- Перед работой: `git pull --rebase origin main`. Если рабочая копия грязная — спроси, что делать, не смешивай чужие правки со своими.
- Коммитить после каждой логически завершённой правки, прошедшей `pnpm lint && pnpm exec tsc --noEmit`. Одна логическая правка = один коммит, не копить разнородные задачи в кучу (скрипта `typecheck` в `package.json` нет; если добавится — использовать его).
- Формат сообщения — conventional commits: `fix(player): ...`, `feat(api): ...`, `chore(deps): ...`. По стилю репо заголовок и тело на английском; русский — только если нет внятного английского эквивалента.
- Push в `origin/<текущая-ветка>` сразу после коммита.
- **Сейчас репо в режиме trunk-based:** работаем напрямую в `main`, потому что branch protection и CI ещё не настроены (см. план в `/home/operator1/projects/dev-strategy.md` — Ступени 2–3, GitHub Flow). Когда CI заработает — переходим на `feat/*` / `fix/*` + PR в `main`. Ветки `develop` не будет.

## Без подтверждения — делай сам

- commit, push, pull, rebase (локальный), merge fast-forward, создание PR через `gh pr create`.
- Чтение и правка любых файлов проекта.
- `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm exec tsc --noEmit` локально.

## Только по явной команде

- Запуск `scripts/deploy-openmaic.sh` (скрипт в `/home/operator1/projects/litellm+video/ai-gateway/scripts/`). Триггеры: «задеплой», «ship», `/deploy`.
- `git reset --hard`, `git push --force`, удаление веток, `git rebase -i`.
- Любые команды на тест-сервере (`ssh test …`, `docker …` через SSH).
- Правки `.env`, `server-providers.yml` и других файлов с секретами.

## Запрещённые зоны

- **Браузерный Web Speech API** (`speechSynthesis.*`, `new SpeechSynthesisUtterance`) запрещён в этом форке: для русского звучит неразборчиво и перебивал Gemini TTS (инцидент: 5-й урок, слайд 7). Заглушки с маркером `[osvaivai:no-browser-tts]` в `lib/playback/engine.ts`, `lib/audio/browser-tts-preview.ts`, `lib/hooks/use-browser-tts.ts` **не восстанавливать** при мерже апстрима.
- TypeScript strict: не оставлять dead code после `return` внутри функций с narrowing через closures (setTimeout, if-ветки) — `next build` падает. Если тело неактуально — удалять целиком, git history хранит историю.

## Стек и инфраструктура

- Next.js 16 (`output: 'standalone'`), TypeScript strict, pnpm 10.
- Docker deploy: образ собирается на тест-сервере через `docker compose build`, контейнер — `openmaic-ru-openmaic-1`.
- Тест-сервер: SSH alias `test` → `51.38.192.142`.
- Деплой-скрипт: `/home/operator1/projects/litellm+video/ai-gateway/scripts/deploy-openmaic.sh`. Флаги: `--no-build` для docs-only изменений.
- **Зависимость от ai-gateway:** TTS (Gemini 2.5) и LLM-роутинг идут через `ai-gateway` (контейнеры `ai-gateway-litellm-1`, `ai-gateway-media-gateway-1` в сети `ai-gateway_default`). Эндпоинты и алиасы (`llm`, `tts`) определены в `/home/operator1/projects/litellm+video/ai-gateway/litellm_config.yaml` — переименование там сломает фронт без предупреждения.

## Эскалация

Если не уверен — спроси одним коротким вопросом, не иди обходным путём. Лучше потратить 30 секунд на подтверждение, чем час на откат.
