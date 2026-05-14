/**
 * Prompt Loader - Loads prompts from markdown files
 *
 * Supports:
 * - Loading prompts from templates/{promptId}/ directory
 * - Snippet inclusion via {{snippet:name}} syntax
 * - Conditional blocks via {{#if conditionName}}...{{/if}} syntax
 * - Variable interpolation via {{variable}} syntax
 * - Caching for performance
 *
 * Feature flags (env):
 * - USE_FILE_PROMPTS (default 'true') — kept for parity with the upstream
 *   integration plan. Our fork has been file-based since the initial commit
 *   (PR #459 was already merged at fork time), so the only effect of setting
 *   this to 'false' is that loadPrompt() returns null and the caller is forced
 *   to fail loudly. There is no TS-coded fallback to roll back to.
 * - USE_CONDITIONAL_PROMPT_BLOCKS (default 'true') — gates the {{#if}} block
 *   processing introduced from upstream PR #490. When 'false', conditional
 *   markers stay as literal text in the rendered prompt, which is a safe
 *   no-op for templates that don't yet use the syntax.
 */

import fs from 'fs';
import path from 'path';
import type { PromptId, LoadedPrompt, SnippetId } from './types';
import { createLogger } from '@/lib/logger';
const log = createLogger('PromptLoader');

// Cache for loaded prompts and snippets
const promptCache = new Map<string, LoadedPrompt>();
const snippetCache = new Map<string, string>();

function isFlagDisabled(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return raw === 'false' || raw === '0' || raw.toLowerCase() === 'no';
}

/**
 * Whether file-based prompt loading is enabled.
 * Exposed for tests and for callers that want to fail-fast when the
 * flag is misconfigured.
 */
export function isFilePromptsEnabled(): boolean {
  return !isFlagDisabled('USE_FILE_PROMPTS');
}

/**
 * Whether {{#if}} conditional block processing is enabled.
 */
export function isConditionalBlocksEnabled(): boolean {
  return !isFlagDisabled('USE_CONDITIONAL_PROMPT_BLOCKS');
}

/**
 * Get the prompts directory path
 */
function getPromptsDir(): string {
  // In Next.js, use process.cwd() for the project root
  return path.join(process.cwd(), 'lib', 'generation', 'prompts');
}

/**
 * Load a snippet by ID
 */
export function loadSnippet(snippetId: SnippetId): string {
  const cached = snippetCache.get(snippetId);
  if (cached) return cached;

  const snippetPath = path.join(getPromptsDir(), 'snippets', `${snippetId}.md`);

  try {
    const content = fs.readFileSync(snippetPath, 'utf-8').trim();
    snippetCache.set(snippetId, content);
    return content;
  } catch {
    log.warn(`Snippet not found: ${snippetId}`);
    return `{{snippet:${snippetId}}}`;
  }
}

/**
 * Process snippet includes in a template.
 * Replaces {{snippet:name}} with actual snippet content.
 */
export function processSnippets(template: string): string {
  return template.replace(/\{\{snippet:(\w[\w-]*)\}\}/g, (_, snippetId) => {
    return loadSnippet(snippetId as SnippetId);
  });
}

/**
 * Process conditional blocks in a template.
 * Replaces {{#if conditionName}}...{{/if}} with the inner content when the
 * named condition is truthy in `conditions`, or removes the block when it
 * is falsy.
 *
 * Blocks do not nest — this is intentional to keep the prompt templating
 * language simple and reviewable. If a future template needs nested blocks,
 * extract one of them into a snippet and include it via {{snippet:name}}.
 *
 * No-op when USE_CONDITIONAL_PROMPT_BLOCKS=false (markers stay as literal
 * text — which is also a safe no-op for templates that don't use the syntax).
 */
export function processConditionalBlocks(
  template: string,
  conditions: Record<string, unknown>,
): string {
  if (!isConditionalBlocksEnabled()) return template;
  return template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, conditionName: string, content: string) => {
      return conditions[conditionName] ? content : '';
    },
  );
}

/**
 * Load a prompt by ID
 */
export function loadPrompt(promptId: PromptId): LoadedPrompt | null {
  if (!isFilePromptsEnabled()) {
    log.warn(
      `loadPrompt(${promptId}) refused: USE_FILE_PROMPTS=false. ` +
        `There is no TS-coded fallback in this fork; set USE_FILE_PROMPTS=true (default) to re-enable.`,
    );
    return null;
  }

  const cached = promptCache.get(promptId);
  if (cached) return cached;

  const promptDir = path.join(getPromptsDir(), 'templates', promptId);

  try {
    // Load system.md
    const systemPath = path.join(promptDir, 'system.md');
    let systemPrompt = fs.readFileSync(systemPath, 'utf-8').trim();
    systemPrompt = processSnippets(systemPrompt);

    // Load user.md (optional, may not exist)
    const userPath = path.join(promptDir, 'user.md');
    let userPromptTemplate = '';
    try {
      userPromptTemplate = fs.readFileSync(userPath, 'utf-8').trim();
      userPromptTemplate = processSnippets(userPromptTemplate);
    } catch {
      // user.md is optional
    }

    const loaded: LoadedPrompt = {
      id: promptId,
      systemPrompt,
      userPromptTemplate,
    };

    promptCache.set(promptId, loaded);
    return loaded;
  } catch (error) {
    log.error(`Failed to load prompt ${promptId}:`, error);
    return null;
  }
}

/**
 * Interpolate variables in a template
 * Replaces {{variable}} with values from the variables object
 */
export function interpolateVariables(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value === undefined) return match;
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  });
}

/**
 * Build a complete prompt with variables.
 *
 * Processing order:
 *   1. Snippet includes ({{snippet:name}}) — file content spliced in (done in loadPrompt)
 *   2. Conditional blocks ({{#if flag}}...{{/if}}) — gated on `variables`
 *   3. Variable interpolation ({{varName}}) — values substituted
 */
export function buildPrompt(
  promptId: PromptId,
  variables: Record<string, unknown>,
): { system: string; user: string } | null {
  const prompt = loadPrompt(promptId);
  if (!prompt) return null;

  return {
    system: interpolateVariables(
      processConditionalBlocks(prompt.systemPrompt, variables),
      variables,
    ),
    user: interpolateVariables(
      processConditionalBlocks(prompt.userPromptTemplate, variables),
      variables,
    ),
  };
}

/**
 * Clear all caches (useful for development/testing)
 */
export function clearPromptCache(): void {
  promptCache.clear();
  snippetCache.clear();
}
