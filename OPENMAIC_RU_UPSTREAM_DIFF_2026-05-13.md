# OpenMAIC-RU vs upstream OpenMAIC

**Дата анализа:** 2026-05-13  
**Репозиторий:** `/home/operator1/projects/OpenMAIC-RU`  
**Сравнение:** `origin/main` / локальный `main` OpenMAIC-RU против `upstream/main` THU-MAIC/OpenMAIC  
**Важно:** документ подготовлен по git-истории и текущему working tree репозитория OpenMAIC-RU. Существующие markdown-отчеты из других репозиториев не являются источником этого файла.

## Короткий Вывод

OpenMAIC-RU и upstream OpenMAIC после общего предка развивались как две самостоятельные ветки, а не как "форк чуть отстал от upstream". Upstream добавил большую продуктовую волну: i18next, новые провайдеры, web search, Deep Interactive Mode, file-based prompts, export/import ZIP, ACCESS_CODE, eval/e2e harness и много тестов. OpenMAIC-RU в это же время был переориентирован под русскоязычный production/runtime-контур osvaivai: Edge/Gemini TTS, жесткий managed provider mode, internal API perimeter, webhook, embedded player bridge, classroom clone/schema/manifest, partial regeneration, layout post-processing и security fixes.

Прямой merge рискованный: `git merge-tree --write-tree origin/main upstream/main` показывает **50 конфликтных путей**. Самые тяжелые зоны: `lib/server/classroom-generation.ts`, `lib/server/classroom-media-generation.ts`, `lib/server/provider-config.ts`, `lib/server/ssrf-guard.ts`, `lib/audio/*`, `lib/i18n/*`, `lib/prompts/*`, `components/generation/*`, `components/settings/*`, `middleware.ts`, `package.json`, `pnpm-lock.yaml`.

Практическая стратегия: не делать один большой merge. Сначала зафиксировать текущий dirty working tree, затем переносить upstream по слоям: security/provider foundation, тесты, web search/PDF, i18n/prompts, media/TTS, generation/player UI. Для `classroom-generation`, `classroom-media-generation`, `provider-config`, `ssrf-guard`, `middleware`, i18n и prompts нужен ручной merge, а не cherry-pick "как есть".

## Git-Координаты

| Координата | Значение |
|---|---|
| merge-base | `95cdc38` / `95cdc389024b0fa7df3a430767da83fe4b274cdd` |
| merge-base commit | `2026-03-23 test: add Vitest infrastructure with provider-config and settings-sync tests (#144)` |
| OpenMAIC-RU `origin/main` | `ae0d2e4` |
| OpenMAIC-RU HEAD commit | `2026-05-07 fix(security): also allow KaTeX CDN through interactive iframe CSP` |
| upstream `main` | `47cc2a5` |
| upstream HEAD commit | `2026-05-13 feat: add Brave Search and Baidu Search integration` |
| upstream package version | `0.2.1` |
| OpenMAIC-RU package version | `0.1.0` |

Команды для перепроверки:

```bash
cd /home/operator1/projects/OpenMAIC-RU
git fetch --all --prune
git merge-base origin/main upstream/main
git log -1 --date=short --format='%h %ad %s' origin/main
git log -1 --date=short --format='%h %ad %s' upstream/main
git rev-list --count "$(git merge-base origin/main upstream/main)"..upstream/main
git rev-list --count "$(git merge-base origin/main upstream/main)"..origin/main
git diff --shortstat "$(git merge-base origin/main upstream/main)"..upstream/main
git diff --shortstat "$(git merge-base origin/main upstream/main)"..origin/main
```

## Объем Расхождения

| Метрика | upstream OpenMAIC | OpenMAIC-RU |
|---|---:|---:|
| Коммитов после merge-base | 102 | 66 |
| Коммитов без merge-коммитов | 102 | 63 |
| Измененных файлов | 399 | 130 |
| Insertions | 43 367 | 16 364 |
| Deletions | 8 397 | 1 126 |
| Пересекающихся измененных файлов | 65 | 65 |
| Конфликтных путей при merge-tree | 50 | 50 |

У OpenMAIC-RU после merge-base есть 3 merge-коммита:

- `cf5a3ca 2026-03-22 merge: sync with upstream THU-MAIC/OpenMAIC (7 commits)`
- `38947bb 2026-03-23 merge: sync with upstream THU-MAIC/OpenMAIC (7 commits)`
- `d62bfda 2026-04-15 merge: p1-7-idempotency-client (deterministic keys in orchestrator)`

## Текущий Working Tree

На момент анализа working tree OpenMAIC-RU не чистый. Эти изменения не входят в `origin/main`, но важны, потому что меняют текущий classroom/osvaivai контракт:

```text
 M app/api/classroom/[id]/regenerate-asset/route.ts
 M app/api/classroom/[id]/regenerate-interactive/route.ts
 M app/api/classroom/[id]/regenerate-tts/route.ts
 M app/api/classroom/clone/route.ts
 M app/api/classroom/route.ts
 M lib/server/__tests__/managed-mode.test.ts
 M lib/server/classroom-media-generation.ts
 M lib/server/classroom-storage.ts
 M lib/server/ssrf-guard.ts
?? tests/server/classroom-contract.test.ts
```

Содержательно текущие незакоммиченные изменения:

- `app/api/classroom/route.ts`: добавлены `PUT /api/classroom?id=...` для sync scratch classroom из `sourceClassroomJson` и `DELETE /api/classroom?id=...` для удаления classroom JSON плюс директории assets.
- `lib/server/classroom-storage.ts`: добавлен `deleteClassroom`.
- `app/api/classroom/[id]/regenerate-*`: ответы partial regeneration расширены content-address полями: `relativePath`, `sha256`, `contentType`, а для media также `provider`, `model`, для interactive также `html`.
- `lib/server/classroom-media-generation.ts`: вычисляет sha256/content-type для TTS, media и interactive результатов.
- `lib/server/ssrf-guard.ts`: добавлен `allowPrivateIps` / `allowPrivate` escape hatch.
- `app/api/classroom/clone/route.ts`: `ALLOW_PRIVATE_OSVAIVAI` применяется не только при preflight validation, но и при `ssrfSafeFetch`, чтобы MinIO в private Docker network был достижим.
- `tests/server/classroom-contract.test.ts`: untracked контрактные тесты для `PUT`, `DELETE`, middleware и response fields partial regen.

Перед реальным merge эти изменения нужно либо закоммитить на отдельную ветку, либо явно сохранить как patch. Они не выглядят как форматирование: это активное расширение внутреннего OpenMAIC/osvaivai API.

## Что Нового В upstream OpenMAIC

Период upstream-изменений: **2026-03-23 - 2026-05-13**. За это время upstream прошел релизы `v0.1.0`, `v0.1.1`, `v0.2.0`, `v0.2.1`.

### AI-Провайдеры И Модели

Upstream сильно расширил модельный слой и настройки провайдеров.

Ключевые коммиты:

- `2c26e3a feat: Ollama local LLM support (#94)`
- `9badd59 feat: add and expand MiniMax provider support (#182)`
- `eba704e feat(config): add latest OpenAI models to default config (#416)`
- `91b3a70 feat(config): add GLM-5.1 and GLM-5V-Turbo to GLM preset models (#437)`
- `a95aa87 support recent model providers (#481)`
- `4754bba support gpt-5.5 api (#487)`
- `e613b75 [codex] add per-model thinking config (#494)`
- `10b1fc8 Fix Haiku 4.5 thinking controls (#501)`
- `be759a8 feat: add lemonade to provider (#508)`
- `b29efe1 fix: remove weak Lemonade recommended models (#567)`

Добавлено или существенно расширено:

- Ollama как локальный OpenAI-compatible LLM без API-ключа.
- MiniMax: LLM, TTS, image и video presets.
- OpenRouter, Tencent/Hunyuan/Hy3, Xiaomi MiMo.
- Актуальные OpenAI/GPT-5.5, GLM-5.1, GLM-5V-Turbo и новые preset-модели.
- Per-model thinking config: reasoning/thinking настройки на уровне модели.
- Lemonade local server для LLM/TTS/ASR/image.
- International base URL chips для ряда провайдеров.

Затронутые зоны:

- `lib/ai/providers.ts`
- `lib/ai/model-metadata.ts`
- `lib/ai/thinking-config.ts`
- `lib/server/provider-config.ts`
- `lib/server/resolve-model.ts`
- `lib/store/settings.ts`
- `components/settings/*`
- `tests/ai/*`
- `tests/server/provider-config.test.ts`

Ценность для OpenMAIC-RU высокая: новые провайдеры и thinking config полезны. Риск тоже высокий: OpenMAIC-RU имеет свой managed provider mode, ai-gateway, Gemini TTS, Edge TTS и серверный authority над client model/provider. Переносить надо через ручное объединение `provider-config`, `resolve-model`, `settings` и тестов.

### Web Search И PDF

Upstream добавил полноценную ветку web-search провайдеров и PDF-aware search.

Ключевые коммиты:

- `531b3c1 feat: make Tavily web search query context-aware when PDF is uploaded (#258)`
- `dbe1d2e [codex] Add Bocha web search provider (#524)`
- `47cc2a5 feat: add Brave Search and Baidu Search integration`
- `91c4015 feat(pdf): add MinerU Cloud API as PDF parsing provider (#438)`

Новые возможности:

- LLM-rewrite поискового запроса, если генерация идет с PDF или длинным requirement.
- Bocha Search.
- Brave Search.
- Baidu Search с web/baike/scholar sub-sources.
- MinerU Cloud как PDF provider.
- Settings UI и tests для web search providers.

Затронутые зоны:

- `app/api/web-search/route.ts`
- `lib/web-search/*`
- `lib/server/web-search-config.ts`
- `lib/server/search-query-builder.ts`
- `components/settings/web-search-settings.tsx`
- `components/settings/pdf-settings.tsx`
- `lib/pdf/mineru-cloud.ts`
- `tests/web-search/*`
- `tests/server/web-search-config.test.ts`

Для OpenMAIC-RU это полезно, но перенос должен пройти через существующие SSRF/managed provider ограничения. Standalone provider files можно брать почти целиком, но route/config/settings нужно интегрировать вручную.

### I18n

Upstream сделал структурную миграцию i18n.

Ключевые коммиты:

- `ad9e0ee refactor(i18n): migrate to i18next framework (#331)`
- `4a93d97 feat: add Russian language (ru-RU) support for interface and AI agents (#261)`
- `d81b4de feat(i18n): add Japanese (ja-JP) locale (#365)`
- `3e8a304 feat(i18n): add Arabic (ar-SA) language support (#431)`
- `7cae6d3 feat(i18n): add Traditional Chinese (zh-TW) UI locale support (#517)`
- `a47b2d2 Feat/439 i18n key alignment check (#447)`

Что поменялось:

- Старые TypeScript словари `lib/i18n/chat.ts`, `common.ts`, `generation.ts`, `settings.ts`, `stage.ts` удаляются в пользу `lib/i18n/locales/*.json`.
- Добавлен i18next.
- Добавлен `components/language-switcher.tsx`.
- Добавлен CI/script `check:i18n-keys`.
- Upstream теперь имеет собственный `ru-RU.json`, но это не то же самое, что RU-форковая русификация.

Риск для OpenMAIC-RU очень высокий. RU-форк менял именно старые `lib/i18n/*` файлы и русскоязычные UX-строки. При переносе нельзя просто принять upstream: нужно перенести RU-термины и player/generation фразы в новую JSON-структуру, затем прогнать key alignment.

### Prompts И Orchestration

Upstream вынес prompt-систему из кода в markdown templates и добавил новые prompt mechanisms.

Ключевые коммиты:

- `f40c92f refactor(orchestration): migrate prompt builders to file-based templates (#459)`
- `fc6b186 refactor(whiteboard): file-based prompts + geometry conflict detection (#485)`
- `3fafca5 feat(prompts): conditional media snippets in generation prompts (#490)`
- `470aa5e feat: inline language inference for outline and PBL generation (#412)`
- `550c43a fix(generation): unify languageDirective across outline + scene pipeline (#472)`
- `c02a607 feat: interactive mode clean (#461)`

Что появилось:

- Новый корень `lib/prompts/*` вместо части `lib/generation/prompts/*`.
- File-based orchestration prompts для agents/director/PBL/whiteboard.
- Conditional snippets `{{#if ...}}`.
- Media snippets для image/video с включением только при active capabilities.
- Whiteboard reference snippet и `whiteboard-conflicts` summarizer.
- Language directive, проходящий через outline и scene generation.
- Templates для game/code/diagram/simulation/visualization3d/widget teacher actions.

Затронутые зоны:

- `lib/prompts/*`
- `lib/generation/outline-generator.ts`
- `lib/generation/scene-generator.ts`
- `lib/orchestration/prompt-builder.ts`
- `lib/orchestration/summarizers/*`
- `lib/pbl/pbl-system-prompt.ts`
- `tests/prompts/*`
- `tests/generation/media-prompt-wiring.test.ts`

Для OpenMAIC-RU это ценная архитектурная миграция, но она конфликтует с RU prompt-правками: русская teacher persona, женские формы, scene count/keyPoints density, depth block, TTS speech guidelines, запрет текста в video prompts, layout constraints. Это должна быть отдельная ручная задача.

### Deep Interactive, Whiteboard И Classroom UX

Ключевые коммиты:

- `c02a607 feat: interactive mode clean (#461)`
- `c75cf6e feat: add code element support for whiteboard (#385)`
- `45929cf fix(whiteboard): code element captures internal scroll/drag (#530) (#544)`
- `66c6229 fix: improve whiteboard UX with bounded canvas and history fixes (#235)`
- `ea0e812 feat: whiteboard layout quality eval harness (#425)`
- `7d47b0a refactor(eval): unify outline-language and whiteboard-layout harness (#453)`
- `a5209d7 feat(outline-review): clickable streaming card morphs into editor (#558)`

Что появилось:

- Deep Interactive Mode с widget types: game, simulation, 3D visualization, code, diagram/mindmap.
- Interactive responsive assets and showcases.
- Code element для whiteboard.
- Whiteboard layout eval harness.
- Outline-review flow: streaming card morphs into editor.

Риск для OpenMAIC-RU высокий: RU-форк уже имеет layout post-processing для кириллицы, player bridge и embedded mode. Upstream interactive changes трогают `interactive-renderer`, `stage`, `scene-generator`, prompts и types.

### Media, TTS И ASR

Ключевые коммиты:

- `ddb5224 feat: add Discussion TTS with per-agent voice assignment (#211)`
- `6945707 feat(tts): add Doubao TTS 2.0 (Volcengine Seed-TTS 2.0) provider (#283)`
- `5adf91c feat(settings): add configurable model selection for TTS and ASR (#108)`
- `3c687dd fix(tts): unify model selection to per-provider and fix ElevenLabs model_id (#326)`
- `9a0060e feat(audio): add custom OpenAI-compatible TTS/ASR provider support (#357)`
- `5e12ad8 [codex] add VoxCPM2 TTS provider (#496)`
- `be759a8 feat: add lemonade to provider (#508)`
- `46b61de feat: add HappyHorse video adapter (#509)`
- `58acad5 feat: support OpenAI image env fallback (#510)`
- `2dff6d1 feat: add generated video manifest refs (#540)`
- `22c637c Fix generated video thumbnails (#546)`

Что появилось:

- Discussion TTS с per-agent voice assignment.
- Custom OpenAI-compatible TTS/ASR.
- Doubao, VoxCPM2, Lemonade TTS/ASR.
- MiniMax/Lemonade/OpenAI image providers.
- HappyHorse video adapter.
- Video manifest refs and generated video thumbnails.
- Улучшения settings UI для TTS/ASR/media.

OpenMAIC-RU уже глубоко менял TTS/media слой: Edge TTS, Russian normalization, Gemini TTS через ai-gateway, browser TTS disabled, versioned audio/media paths, TTS metadata, force partial regen, retries, placeholder cleanup. Поэтому перенос upstream TTS/ASR нельзя делать простым overwrite.

### Player, Roundtable И Completion

Ключевые коммиты:

- `0533adb feat: refine presentation mode speech bubbles, input flow, and accessibility (#195)`
- `e3bdc47 feat: keyboard shortcuts for roundtable (T/V/Escape/Space) (#256)`
- `1735ced fix(roundtable): prevent TTS segments from overlapping on rapid pause/resume (#286)`
- `59e6d2f fix(roundtable): pause TTS and bubble text instead of interrupting when input box opens (#295)`
- `f86c048 feat: end-of-course completion page + persistent quiz state (#484)`
- `d7068a8 feat(home): inline search for recent classrooms (#476)`
- `e8eba95 feat: add course rename (partial #34) (#58)`

Что появилось:

- Более зрелый presentation/roundtable UX.
- Keyboard shortcuts.
- Persistent quiz answers and grading state.
- End-of-course completion page.
- Recent classroom search.
- Course rename.

OpenMAIC-RU имеет embedded-specific player behavior, osvaivai postMessage bridge и собственную семантику `lesson:end`. Переносить можно выборочно, особенно TTS overlap fixes и video thumbnail fixes, но stage/player changes надо проверять через embedded osvaivai сценарий.

### Security И Access

Ключевые коммиты:

- `787e2d1 Create SECURITY.md (#281)`
- `25f7908 fix: add structured request context to all API error logs (#337)`
- `7474290 fix(ssrf): add ALLOW_LOCAL_NETWORKS env var for self-hosted deployments (#366)`
- `96a4448 fix: resolve DNS before SSRF validation to prevent rebinding bypass (#386)`
- `c071e02 feat: ACCESS_CODE site-level authentication (#407)`
- `ca550aa feat(security): add anti-framing headers (X-Frame-Options + CSP frame-ancestors) (#430)`
- `cce7087 Fix action filtering logic and add safety improvements (#163)`

Что появилось:

- DNS resolution before SSRF validation.
- `ALLOW_LOCAL_NETWORKS` for self-hosted deployments.
- Site-level `ACCESS_CODE` auth.
- Anti-framing headers with optional `ALLOWED_FRAME_ANCESTORS`.
- Structured API error logging.
- Action filtering safety improvements.

Пересечение с OpenMAIC-RU очень серьезное:

- RU уже имеет P0 SSRF/connectivity remediation.
- RU имеет `INTERNAL_ACCESS_KEY` middleware для osvaivai internal API.
- RU имеет HMAC-signed webhook.
- RU имеет sandbox/CSP для interactive HTML, включая Tailwind/KaTeX allowlist.
- RU embedded player зависит от iframe embedding; upstream anti-framing без корректного allowlist может сломать osvaivai.

### Export / Import

Ключевые коммиты:

- `db7f187 feat: classroom export and import (ZIP) (#408)`
- `247ec57 fix(export): use latest classroom name from IndexedDB for ZIP filename (#435)`
- `7cf3928 fix(export): skip shapes with malformed SVG paths instead of aborting PPTX export (#505)`
- `757ac07 fix: preserve discussion triggers in imported classroom zips (#557)`
- `3149955 fix: prevent memory leaks and silent export failures (#552)`

Ценность высокая, особенно ZIP export/import и PPTX robustness. Но OpenMAIC-RU имеет manifest/TTS metadata/versioned media/osvaivai clone contract. ZIP format нужно расширять или проверять, чтобы import/export не терял manifest и media history.

### Tests И Tooling

Ключевые коммиты:

- `37e0455 test: add Playwright e2e testing framework with core scenario coverage (#229)`
- `2356d28 test(e2e): add end-to-end generation happy path test (#401)`
- `ea0e812 feat: whiteboard layout quality eval harness (#425)`
- `7d47b0a refactor(eval): unify outline-language and whiteboard-layout harness (#453)`
- `a47b2d2 Feat/439 i18n key alignment check (#447)`

Новые тестовые области:

- `e2e/*`
- `tests/web-search/*`
- `tests/media/*`
- `tests/audio/*`
- `tests/prompts/*`
- `tests/server/ssrf-guard.test.ts`
- `tests/export/*`
- `eval/whiteboard-layout/*`
- `eval/outline-language/*`

Для OpenMAIC-RU это полезно как safety net, но `package.json`, `pnpm-lock.yaml`, `vitest.config.ts` конфликтуют. Тесты стоит переносить раньше крупных фич, но адаптировать под managed mode и osvaivai runtime.

## Что Уникально В OpenMAIC-RU

OpenMAIC-RU после merge-base ушел в сторону русскоязычного production/runtime для osvaivai.

### Русская Локализация И Русская Педагогическая Подача

Ключевые коммиты:

- `84659bd feat: полная русская локализация (ru-RU) + Edge TTS для русской озвучки`
- `2beedab feat: README на русском + автоподбор голоса по полу агента`
- `f8a5f8d feat(i18n,a11y): localize player toolbar aria-labels + agent persona`
- `ad6246d feat(prompts): teacher persona uses feminine forms in Russian speech`

Что изменено:

- Русские UI-словари в старой TS i18n системе.
- Русские agent/persona настройки.
- Русский README как основной.
- `README-en.md` для английской версии.
- Русские toolbar labels и a11y labels.
- Женские формы для teacher persona.

Отличие от upstream: upstream позже добавил `ru-RU.json`, но OpenMAIC-RU имеет более osvaivai/RU-specific фразеологию и TTS-настройки.

### Edge TTS, Gemini TTS И Русская Нормализация

Ключевые коммиты:

- `84659bd` Edge TTS и русские голоса.
- `2beedab` auto voice by teacher gender.
- `fe6e849` comprehensive Russian TTS normalization.
- `b7bbc88` media generation integrations and normalizer.
- `a80dccd` Gemini TTS via ai-gateway with classroom-level pinning.
- `bd937ad` env mapping `TTS_GEMINI_*`.
- `0f02147`, `6997e3e`, `af0062b` disabling/hardening browser TTS fallback.
- `ed8d8b5`, `e792de2`, `ae9e5c6` TTS metadata/versioning/partial regen.

Возможности:

- Edge TTS provider.
- Русские голоса и gender-aware voice selection.
- Нормализация русской речи: аббревиатуры, числа, `ё`, proper nouns.
- `scripts/normalizer.py` и `scripts/data/proper_nouns`.
- Gemini TTS через ai-gateway.
- Browser TTS fallback фактически отключен, чтобы не ломать server-generated audio.
- TTS writes to versioned audio paths: `audio/{actionId}/vNNN.ext`.
- SpeechAction получает `tts` metadata и `textHash`.
- Partial TTS regeneration с force mode.

### Osvaivai Webhook И Player Bridge

Ключевые коммиты:

- `4308e46 feat: add osvaivai webhook on lesson generation complete`
- `77ac3dc fix: add jobId to osvaivai webhook payload`
- `0323421 remediation: P0 SSRF/connectivity + P1 webhook signing + P1.9 origin fix`
- `4a56860 feat(classroom): instrument stage timings and extend webhook payload`
- `e386e90 feat(player-bridge): postMessage hooks for osvaivai iframe integration`
- `0857e44 fix(player): defer lesson:end until last quiz reaches reviewing phase`

Возможности:

- OpenMAIC отправляет webhook в osvaivai после server-side generation.
- Payload содержит `jobId`, `classroomId`, title, scene count, paths, timings/config.
- HMAC webhook signing.
- Player bridge отправляет events наружу для iframe host:
  - `scene:change`
  - `quiz:answer`
  - `lesson:end`
- `lesson:end` задерживается до корректного final quiz reviewing phase.

Такого контракта в upstream нет.

### Internal API Perimeter

Ключевые коммиты:

- `927cc78 feat: add optional internal access key middleware`
- `67cf806 feat(schema): export classroom JSON Schema for osvaivai consumer`

Возможности:

- `INTERNAL_ACCESS_KEY` защищает `/api/*` через `X-Internal-Key`.
- `/api/schema/classroom` может быть public при `SCHEMA_PUBLIC=1`.
- Этот perimeter ориентирован на внутреннюю Docker/network схему osvaivai, а не на публичный password gate.

Конфликт с upstream: upstream добавил `ACCESS_CODE` site-level authentication с cookie `openmaic_access`. Эти middleware должны быть объединены явно: `ACCESS_CODE` для standalone/shared deployment, `INTERNAL_ACCESS_KEY` для internal API mode.

### Classroom Schema, Manifest И Clone Contract

Ключевые коммиты:

- `e792de2 feat(classroom): add asset manifest and TTS metadata types, versioned media paths`
- `74fbfee chore(classroom): backfill manifest + TTS metadata for legacy classrooms`
- `67cf806 feat(schema): export classroom JSON Schema for osvaivai consumer`
- `cd3b623 feat(classroom): add secured /api/classroom/clone endpoint`

Возможности:

- `ClassroomManifest` со schema version, asset entries, versions, currentVersion, prompt/provider/model/params.
- TTS metadata внутри `SpeechAction`.
- Backfill legacy classrooms.
- Generated JSON schema: `lib/generated/classroom.schema.json`.
- `GET /api/schema/classroom`.
- Secured `POST /api/classroom/clone`:
  - принимает `sourceClassroomJson`;
  - принимает `manifest`;
  - принимает список assets с `canonicalPath`, `signedUrl`, `sha256`;
  - проверяет host allowlist `OSVAIVAI_MINIO_HOST`;
  - применяет SSRF guard;
  - проверяет signed URL TTL;
  - проверяет sha256 после download;
  - ограничивает JSON/assets sizes;
  - rate-limits clone requests;
  - генерирует server-side classroom id;
  - переписывает `asset://...` в `/api/classroom-media/{newClassroomId}/...`;
  - сохраняет classroom на локальный disk runtime.

Такого clone/schema/manifest контракта в upstream нет.

### Partial Regeneration

Ключевые коммиты:

- `ed8d8b5 feat(classroom): add /api/classroom/[id]/regenerate-tts endpoint`
- `ae9e5c6 feat(classroom): partial regen endpoints + force mode for TTS`

Endpoints:

- `POST /api/classroom/[id]/regenerate-tts`
- `POST /api/classroom/[id]/regenerate-asset`
- `POST /api/classroom/[id]/regenerate-interactive`

Возможности:

- TTS regeneration по action ids или full pass.
- Idempotency через `textHash`.
- Force mode для TTS.
- Image/video asset regeneration по element id.
- Interactive HTML regeneration по scene id.
- Versioned paths для audio/media/interactive.
- Manifest update после regeneration.

Текущий dirty working tree расширяет эти responses content-address полями, что делает partial regen пригоднее для osvaivai editor pipeline.

### Generation Pipeline: Size Profiles, Parallelism, Telemetry

Ключевые коммиты:

- `48ea569 fix(generate): honor explicit enable*=false in managed mode`
- `4a56860 feat(classroom): instrument stage timings and extend webhook payload`
- `743bfb0 feat(generation): accept lesson size profile`
- `1f69437 feat(classroom): bounded-parallel scene generation with context summaries`

Возможности:

- Explicit `enableImageGeneration=false` / `enableVideoGeneration=false` respected even in managed mode.
- Lesson size profile accepted by `/api/generate-classroom`.
- Bounded-parallel scene generation.
- Context summaries for parallel scene generation.
- Stage timings in generation result/webhook.
- Extended webhook config payload.

Эти изменения пересекаются с upstream `languageDirective`, generated agent configs, video manifest refs и prompt relocation.

### Layout И Media Stability

Ключевые коммиты:

- `42477fa fix(slide-layout): post-process pass to fit Cyrillic text in shape boxes`
- `b2227a7 feat(slide-layout): post-generation auto-correct + stricter prompt`
- `3a42418 slide-layout-fit: pull up, squeeze, drop`
- `4975693 fix(layout): dedupe shapes, round coords, keep decorations with containers`
- `43ac870 fix(layout): alignment owner + non-destructive drop in fitSlideLayout`
- `2dc3ee3 fix(layout): split BLOCK vs INLINE tags in estimateTextHeight`
- `78e7d20 feat(layout): safe auto-shrink for clipped/overflow text`
- `ae81dfb feat(layout): FitResult metrics + validator-driven retry hook`
- `4eb8609 Fix generated slide layout and media cleanup`
- `6ef2549 Add deterministic slide overlap and contrast guards`
- `9d0f415 Drop unreadable overlaps in persisted slide layout fix`
- `16641c4 fix(layout): keep decorative lines attached to text`
- `3e8ba98 fix(media-gen): retry image/video 3x, drop unresolved placeholders`
- `a9cae23 feat(prompts): forbid on-screen text in video media prompts`
- `facbfac classroom-media: drop immutable cache, use ETag + must-revalidate`

Возможности:

- Post-processing layout fix for Cyrillic text.
- Overflow/clipping/overlap/contrast guards.
- Deterministic dropping of unreadable overlaps.
- Keep decorative lines attached to text.
- Retry image/video generation.
- Remove unresolved media placeholders.
- Avoid immutable caching for classroom media.

Upstream имеет whiteboard conflict detector/eval harness, но это другой слой. Его стоит использовать как дополнительную проверку, а не замену RU layout post-processing без сравнения.

### Interactive Security

Ключевые коммиты:

- `57198a6 fix(security): sandbox interactive HTML slides + sanitize markup`
- `982e335 fix(security): allow Tailwind CDN through interactive iframe CSP`
- `ae0d2e4 fix(security): also allow KaTeX CDN through interactive iframe CSP`

Возможности:

- Interactive HTML sandboxing.
- Sanitizing/removing risky markup.
- CSP allowlist для Tailwind и KaTeX CDN, которые нужны текущим generated interactive slides.

Конфликт с upstream: upstream менял interactive renderer в Deep Interactive Mode и добавил anti-framing headers. Нужно сохранить RU sandbox/CSP assumptions и embedded compatibility.

### Docker, ai-gateway И Build

Ключевые коммиты:

- `d33e8c0 chore: stage pending UI, playback, and Docker changes`
- `0456038 feat(deploy): connect to ai-gateway via ai-gateway_default network`
- `14379ba build: register proper noun dictionaries submodule`
- `67cf806` добавил `schema:classroom` script и `typescript-json-schema`.

Возможности:

- Docker image ставит runtime dependencies для Edge/RU TTS normalization.
- docker-compose подключается к `openmaic-net` и `ai-gateway_default`.
- OpenMAIC-RU не обязан публиковать порт наружу в osvaivai topology.
- Proper noun dictionaries как submodule.

## Сравнение По Подсистемам

| Подсистема | upstream OpenMAIC | OpenMAIC-RU | Merge-вывод |
|---|---|---|---|
| LLM providers | Ollama, OpenRouter, Tencent, Xiaomi, refreshed OpenAI/GLM/GPT-5.5, thinking config | Managed provider mode, server authority, ai-gateway assumptions, DeepSeek outputWindow tweak | Переносить provider registry вручную, сохранить managed mode |
| TTS/ASR | Doubao, VoxCPM2, Lemonade, custom OpenAI-compatible, configurable model selection | Edge TTS, Gemini TTS, RU normalization, browser TTS disabled, TTS metadata/versioning | Высокий риск, начинать с tests/adapters |
| Web search | Tavily rewrite, Bocha, Brave, Baidu | Почти отсутствует как upstream feature; есть SSRF/managed perimeter | Standalone providers можно взять, route/config вручную |
| PDF | MinerU Cloud provider | PDF route hardened through RU SSRF/connectivity | Взять provider после SSRF review |
| i18n | i18next + JSON locales incl ru/ja/ar/zh-TW | Старые TS словари с глубокой RU локализацией | Нужна миграция RU строк в JSON |
| Prompts | File-based templates, conditional snippets, whiteboard references | Старые templates с RU/lesson density/layout/video/TTS правками | Нужна ручная prompt migration |
| Interactive | Deep Interactive Mode, widget types, code/game/sim/3D | Sandbox/CSP, embedded runtime compatibility, partial interactive regen | Интеграция вручную, не перетирать sandbox |
| Generation | languageDirective, video manifest refs, outline editor improvements | parallel scenes, lesson profile, timings/webhook, manifest/TTS metadata | `classroom-generation` вручную |
| Media pipeline | new providers, video thumbnails, ZIP/import fixes | versioned media, retries, placeholder cleanup, clone/manifest contract | `classroom-media-generation` вручную |
| Player | roundtable/presentation improvements, completion page | embedded mode, postMessage bridge, osvaivai lesson:end semantics | Выборочные cherry-pick с embedded e2e |
| Security | ACCESS_CODE, DNS SSRF fix, anti-framing | INTERNAL_ACCESS_KEY, HMAC webhook, SSRF guard, sandbox/CSP, managed provider | Объединять политики явно |
| Export/import | ZIP import/export, PPTX robustness | Export in embedded mode, manifest/versioned media side effects | Проверить ZIP format под RU manifest |
| Tests | Playwright, eval, web-search/media/audio/prompts tests | RU-specific tests for layout, SSRF, webhook, managed mode, TTS normalization | Переносить tests рано, адаптировать configs |

## Конфликтные Пути При Прямом Merge

Команда:

```bash
git merge-tree --write-tree origin/main upstream/main
```

Уникальные конфликтные пути:

```text
.env.example
.gitignore
README.md
app/api/azure-voices/route.ts
app/api/generate-classroom/route.ts
app/api/generate/image/route.ts
app/api/generate/scene-content/route.ts
app/api/generate/tts/route.ts
app/api/proxy-media/route.ts
app/page.tsx
components/generation/generation-toolbar.tsx
components/generation/media-popover.tsx
components/generation/outlines-editor.tsx
components/header.tsx
components/roundtable/index.tsx
components/scene-renderers/interactive-renderer.tsx
components/settings/audio-settings.tsx
components/settings/index.tsx
components/stage.tsx
components/stage/scene-renderer.tsx
lib/ai/providers.ts
lib/audio/constants.ts
lib/audio/tts-providers.ts
lib/audio/types.ts
lib/generation/prompts/snippets/tts-speech-guidelines.md
lib/generation/prompts/types.ts
lib/generation/scene-generator.ts
lib/hooks/use-i18n.tsx
lib/hooks/use-scene-generator.ts
lib/i18n/chat.ts
lib/i18n/common.ts
lib/i18n/generation.ts
lib/i18n/index.ts
lib/i18n/settings.ts
lib/i18n/stage.ts
lib/i18n/types.ts
lib/playback/engine.ts
lib/prompts/templates/requirements-to-outlines/system.md
lib/server/classroom-generation.ts
lib/server/classroom-media-generation.ts
lib/server/provider-config.ts
lib/server/resolve-model.ts
lib/server/ssrf-guard.ts
lib/store/settings.ts
lib/types/generation.ts
lib/utils/model-config.ts
middleware.ts
package.json
pnpm-lock.yaml
vitest.config.ts
```

### Почему Эти Конфликты Сложные

`lib/server/classroom-generation.ts`: upstream добавляет languageDirective, agent config persistence, video manifest refs и новые generation mechanics; RU добавляет profile, bounded parallelism, timings/webhook payload, explicit media flags и osvaivai runtime expectations.

`lib/server/classroom-media-generation.ts`: upstream добавляет providers/video manifest/media behavior; RU добавляет Edge/Gemini TTS, versioned paths, TTS metadata, manifest history, retries, partial regeneration и сейчас WIP content-address fields.

`lib/server/provider-config.ts`, `lib/server/resolve-model.ts`, `lib/store/settings.ts`: upstream расширяет provider registry and keyless local providers; RU вводит managed provider mode и server-controlled credentials/base URLs.

`lib/server/ssrf-guard.ts`: upstream добавляет DNS-before-SSRF и `ALLOW_LOCAL_NETWORKS`; RU уже имеет строгий SSRF guard, connectivity helpers, private MinIO escape hatch и osvaivai-specific host allowlists.

`middleware.ts`: upstream `ACCESS_CODE` vs RU `INTERNAL_ACCESS_KEY`. Это разные threat models.

`lib/i18n/*`: upstream удаляет старые TS dictionaries в пользу i18next JSON; RU меняет старые TS dictionaries.

`lib/prompts/*` и `lib/generation/prompts/*`: upstream переносит prompts в новую структуру; RU меняет старую структуру содержательно.

`components/scene-renderers/interactive-renderer.tsx`: upstream Deep Interactive Mode vs RU sandbox/CSP.

`lib/playback/engine.ts`: upstream player/TTS fixes vs RU отключение browser TTS fallback and embedded semantics.

`package.json`, `pnpm-lock.yaml`, `vitest.config.ts`: dependency and test config conflicts; их нельзя решать без полного install/test pass.

## Дубли И Прямые Противоречия

### Anti-framing vs Embedded osvaivai

Upstream `ca550aa` добавляет `X-Frame-Options: SAMEORIGIN` и CSP `frame-ancestors`. OpenMAIC-RU используется как iframe runtime внутри osvaivai. Если принять upstream headers без `ALLOWED_FRAME_ANCESTORS` или отдельной embedded policy, osvaivai player может перестать загружаться.

Решение: сохранить iframe compatibility. Если переносить anti-framing, сразу настроить allowlist для osvaivai domains и проверить embedded route.

### ACCESS_CODE vs INTERNAL_ACCESS_KEY

Upstream `ACCESS_CODE` защищает shared standalone deployment через user-facing code/cookie. RU `INTERNAL_ACCESS_KEY` защищает internal API для backend-to-OpenMAIC вызовов. Это не взаимозаменяемые механизмы.

Решение: middleware pipeline должен поддерживать оба режима:

- `INTERNAL_ACCESS_KEY` для `/api/*` internal mode, с carve-out для schema при `SCHEMA_PUBLIC=1`.
- `ACCESS_CODE` для standalone pages/API, если OpenMAIC запускается как публичный single app.
- Whitelist health/access-code/schema routes должен быть явным.

### i18next vs RU TS Dictionaries

Upstream удалил старые dictionaries. RU добавил много строк именно в них. Принять upstream означает потерять RU copy. Принять RU означает не получить i18next и future upstream locales.

Решение: мигрировать RU copy в `lib/i18n/locales/ru-RU.json`, затем запускать `pnpm check:i18n-keys`.

### Prompt Relocation vs RU Prompt Rules

Upstream moved prompts to `lib/prompts`; RU rules still live in old templates/snippets.

RU rules that must be preserved:

- Russian teacher persona and feminine forms.
- Lesson scene count and keyPoints density.
- 40-80 word depth block.
- TTS speech guidelines and normalization hints.
- Video prompts must not request on-screen text.
- Slide layout constraints for Cyrillic text.
- Whiteboard teacher persona mandate.

Решение: port rules into new markdown templates/snippets, not into TS code.

### SSRF Policies

Upstream `ALLOW_LOCAL_NETWORKS` is broad self-hosted opt-in. RU `ALLOW_PRIVATE_OSVAIVAI` is narrower for osvaivai MinIO/clone flow and currently also needs fetch-time `allowPrivateIps`.

Решение: keep RU strict SSRF as base; import upstream DNS rebinding protections if stronger; avoid broad `ALLOW_LOCAL_NETWORKS` in production osvaivai mode.

### TTS Provider Stack

Upstream adds several provider families. RU treats TTS as persisted classroom asset generation with versioned files and metadata.

Решение: provider adapters can be imported, but `generateTTSForClassroom` must retain RU metadata/versioning/textHash behavior.

## Что Можно Переносить Cherry-pick С Низким Или Средним Риском

Перед любым cherry-pick делать dry-run на отдельной ветке.

Низкий риск:

- `3149955` memory leaks and silent export failures.
- `7cf3928` malformed SVG path skip in PPTX export.
- Standalone logos/assets that do not affect runtime.
- Some isolated tests where files do not conflict.

Средний риск:

- `22c637c` generated video thumbnails: полезно, но трогает thumbnails/stage storage.
- `d7068a8` recent classroom search: likely UI-only, но проверить RU home page.
- `db7f187` ZIP export/import: useful, но надо расширить под RU manifest/versioned media.
- `91c4015` MinerU Cloud: provider полезен, но route/config through SSRF.
- `dbe1d2e`, `47cc2a5` web-search providers: standalone files почти прямые, но route/settings/config вручную.
- `37e0455`, `2356d28` Playwright/e2e harness: полезно, но configs/fixtures адаптировать.

Высокий риск, но стратегически ценно:

- `f40c92f` file-based prompts.
- `fc6b186` whiteboard prompt refs and conflict detector.
- `3fafca5` conditional media snippets.
- `ad9e0ee` i18next migration.
- `c02a607` Deep Interactive Mode.
- `9a0060e` custom OpenAI-compatible TTS/ASR.
- `5e12ad8` VoxCPM2.
- `be759a8` Lemonade.

## Что Нельзя Переносить Пачкой

- i18n migration without RU copy migration.
- Prompt relocation/orchestration migration without moving RU prompt rules.
- `classroom-generation.ts` wholesale.
- `classroom-media-generation.ts` wholesale.
- `provider-config.ts` / `resolve-model.ts` wholesale.
- `ssrf-guard.ts` wholesale.
- `middleware.ts` wholesale.
- `package.json` + `pnpm-lock.yaml` without dependency install and full test pass.
- Anti-framing headers without osvaivai iframe check.
- ACCESS_CODE middleware without INTERNAL_ACCESS_KEY integration.

## Рекомендуемый План Интеграции

### Фаза 0: Сохранить Текущее Состояние

1. Создать отдельную ветку для merge/integration.
2. Закоммитить или сохранить patch текущих dirty classroom/server изменений.
3. Зафиксировать baseline tests на текущем OpenMAIC-RU.
4. Отдельно зафиксировать contract expectations osvaivai: webhook, player bridge, clone, schema, partial regen responses, embedded player.

### Фаза 1: Foundation Security And Provider Config

Цель: объединить правила безопасности и provider discovery до переноса feature layers.

Сделать:

- Сверить RU `ssrf-guard.ts` с upstream `96a4448`.
- Сохранить RU DNS pinning / host allowlists / private MinIO opt-in.
- Решить policy для `ALLOW_LOCAL_NETWORKS` vs `ALLOW_PRIVATE_OSVAIVAI`.
- Объединить `INTERNAL_ACCESS_KEY` и `ACCESS_CODE` middleware.
- Перенести provider registry additions минимальными slices.
- Добавить tests for managed mode + keyless local providers.

### Фаза 2: Tests First

Сделать:

- Перенести/адаптировать `tests/web-search/*`.
- Перенести/адаптировать upstream `tests/server/ssrf-guard.test.ts`.
- Перенести/адаптировать `tests/media/*`, `tests/audio/*`.
- Подключить Playwright/e2e только после ручного решения `package.json`, `vitest.config.ts`, `pnpm-lock.yaml`.
- Добавить RU-specific tests for:
  - `INTERNAL_ACCESS_KEY`;
  - osvaivai webhook HMAC;
  - embedded postMessage;
  - clone signed URL;
  - partial regen content-address responses;
  - Russian TTS normalization;
  - browser TTS disabled.

### Фаза 3: Web Search And PDF

Сделать:

- Взять standalone `lib/web-search/bocha.ts`, `brave.ts`, `baidu.ts`.
- Интегрировать `lib/server/web-search-config.ts` с RU provider config.
- Интегрировать `app/api/web-search/route.ts` через RU SSRF/managed mode.
- Взять Tavily query rewrite, если prompt migration не блокирует.
- Подключить MinerU Cloud через managed provider config.

### Фаза 4: I18n Migration

Сделать:

- Принять upstream i18next structure.
- Перенести RU strings из старых `lib/i18n/*.ts` в `lib/i18n/locales/ru-RU.json`.
- Сохранить player toolbar/a11y/persona RU copy.
- Запустить key alignment.
- Проверить standalone и embedded UI.

### Фаза 5: Prompt Migration

Сделать:

- Принять `lib/prompts` loader/templates.
- Перенести RU prompt rules из старых templates.
- Перенести `tts-speech-guidelines.md` в новую структуру.
- Перенести video no-on-screen-text rule.
- Перенести lesson size/density/depth rules.
- Проверить generated classroom quality на русском.

### Фаза 6: Generation And Media Pipeline

Сделать:

- Ручной merge `lib/server/classroom-generation.ts`.
- Ручной merge `lib/server/classroom-media-generation.ts`.
- Сохранить RU manifest/versioned paths/TTS metadata/partial regen.
- Добавить upstream video manifest refs and thumbnail fixes.
- Интегрировать new providers after provider foundation is stable.
- Проверить webhook payload compatibility.

### Фаза 7: UI, Player, Interactive

Сделать:

- Перенести end-of-course completion только после проверки osvaivai `lesson:end`.
- Перенести Deep Interactive Mode только вместе с sandbox/CSP review.
- Проверить embedded mode:
  - chat open behavior;
  - export dropdown via `showExport=1`;
  - player bridge events;
  - iframe headers/CSP.

## Обязательные Проверки После Интеграции

Базовый набор:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm exec tsc --noEmit
pnpm check:i18n-keys
```

Targeted tests:

```bash
pnpm vitest run lib/server/__tests__/ssrf-guard.test.ts
pnpm vitest run lib/server/__tests__/managed-mode.test.ts
pnpm vitest run lib/server/__tests__/classroom-media-generation.test.ts
pnpm vitest run tests/audio/tts-normalization.test.ts
pnpm vitest run tests/server/classroom-contract.test.ts
pnpm vitest run tests/web-search
pnpm vitest run tests/media
pnpm vitest run tests/export
```

Manual/e2e smoke:

- Generate classroom in Russian with managed provider mode.
- Generate with image/video/TTS enabled.
- Generate with explicit `enableImageGeneration=false` and `enableVideoGeneration=false`.
- Verify osvaivai webhook signature and payload fields.
- Open embedded classroom in iframe.
- Verify `scene:change`, `quiz:answer`, `lesson:end`.
- Verify final quiz reviewing phase does not emit premature `lesson:end`.
- Verify `showExport=1`.
- Verify clone from osvaivai MinIO signed URLs.
- Verify partial regen TTS/asset/interactive.
- Verify interactive iframe sandbox and Tailwind/KaTeX rendering.
- Verify anti-framing headers allow osvaivai if upstream headers are imported.

## Приоритет Upstream-Фич Для OpenMAIC-RU

| Приоритет | Фича | Почему |
|---|---|---|
| P0 | SSRF DNS rebinding hardening, if stronger than RU implementation | Security foundation |
| P0 | Tests/e2e/eval harness | Needed before risky merge |
| P1 | Web search providers and PDF-aware search | Useful product capability, moderate integration |
| P1 | Export/PPTX robustness fixes | Low-risk quality wins |
| P1 | Video thumbnails / video manifest refs | Aligns with RU media pipeline |
| P2 | i18next migration | Necessary for future upstream compatibility |
| P2 | File-based prompts | Necessary for maintainability |
| P2 | Conditional media snippets | Directly improves prompt adherence |
| P3 | Deep Interactive Mode | Big value, big merge risk |
| P3 | VoxCPM2/Lemonade/custom TTS/ASR | Valuable after TTS foundation is stable |
| P3 | ACCESS_CODE | Useful for standalone deployments, not replacement for internal key |

## Source Commands Used

```bash
git remote -v
git fetch --all --prune
git status --short --branch
git rev-parse --short HEAD
git rev-parse --short origin/main
git rev-parse --short upstream/main
git rev-parse --short "$(git merge-base origin/main upstream/main)"
git log --date=short --format='%h %ad %s' "$(git merge-base origin/main upstream/main)"..upstream/main
git log --date=short --format='%h %ad %s' "$(git merge-base origin/main upstream/main)"..origin/main
git diff --shortstat "$(git merge-base origin/main upstream/main)"..upstream/main
git diff --shortstat "$(git merge-base origin/main upstream/main)"..origin/main
git diff --name-only "$(git merge-base origin/main upstream/main)"..upstream/main
git diff --name-only "$(git merge-base origin/main upstream/main)"..origin/main
git diff --stat --stat-count=80 "$(git merge-base origin/main upstream/main)"..upstream/main
git diff --stat --stat-count=80 "$(git merge-base origin/main upstream/main)"..origin/main
git range-diff "$(git merge-base origin/main upstream/main)"..upstream/main "$(git merge-base origin/main upstream/main)"..origin/main
git merge-tree --write-tree origin/main upstream/main
git show --stat --oneline <commit>
git show <ref>:<path>
```

## Итог

OpenMAIC-RU не стоит подтягивать к upstream одним merge-коммитом. Upstream принес много нужных фич, но они пришли в тех же файлах и подсистемах, где OpenMAIC-RU уже сделал production-specific работу для osvaivai: TTS, generation server, classroom media, security perimeter, player embedding, manifest/schema/clone.

Оптимальный путь - staged integration: сначала зафиксировать текущие RU контрактные изменения, затем переносить upstream по слоям с тестами между слоями. Самые важные invariant, которые нельзя потерять: osvaivai webhook/HMAC, `INTERNAL_ACCESS_KEY`, embedded player bridge, RU TTS normalization, browser TTS disabled behavior, asset manifest/versioned paths, clone security gates, partial regeneration contract, interactive sandbox/CSP and layout safeguards for Cyrillic content.
