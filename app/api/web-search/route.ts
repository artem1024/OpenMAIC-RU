/**
 * Web Search API (Phase 3 / upstream #12 multi-provider).
 *
 * POST /api/web-search
 *   { query, providerId?, apiKey?, baseUrl?, baiduSubSources?, pdfText? }
 *
 * Routes to the configured provider (tavily | brave | bocha | baidu). Each
 * provider must be enabled via env feature flag (defaults to ENABLED for
 * tavily to keep prior behaviour, OFF for the new providers):
 *
 *   WEB_SEARCH_TAVILY_ENABLED  (default true)
 *   WEB_SEARCH_BRAVE_ENABLED   (default false)
 *   WEB_SEARCH_BOCHA_ENABLED   (default false)
 *   WEB_SEARCH_BAIDU_ENABLED   (default false)
 *
 * Provider config (api keys / base URLs) is resolved server-side via
 * `lib/server/provider-config.ts` (managed-mode aware — server is authoritative
 * when MANAGED_PROVIDER_MODE is set; client-supplied keys are dropped).
 *
 * Long requirements (>400 chars) or PDF excerpts are first compressed via
 * `buildSearchQuery()` using the WEB_SEARCH_QUERY_REWRITE prompt template.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  buildSearchQuery,
  SEARCH_QUERY_REWRITE_EXCERPT_LENGTH,
} from '@/lib/server/search-query-builder';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { resolveWebSearchRouteBaseUrl } from '@/lib/server/web-search-config';
import { isManagedProviderMode, logManagedModeBypass } from '@/lib/server/managed-mode';

const log = createLogger('WebSearch');

/**
 * Per-provider feature-flag check. Tavily defaults ON for backward compat; the
 * three new providers default OFF and must be opted-in by the operator.
 */
function isProviderEnabled(providerId: WebSearchProviderId): boolean {
  const envKey = `WEB_SEARCH_${providerId.toUpperCase()}_ENABLED`;
  const raw = process.env[envKey];
  if (providerId === 'tavily') {
    return raw === undefined || raw === '' || raw.toLowerCase() !== 'false';
  }
  return raw !== undefined && raw.toLowerCase() === 'true';
}

function getWebSearchEnvKey(providerId: WebSearchProviderId): string {
  switch (providerId) {
    case 'baidu':
      return 'BAIDU_API_KEY';
    case 'bocha':
      return 'BOCHA_API_KEY';
    case 'brave':
      return 'BRAVE_API_KEY';
    case 'tavily':
    default:
      return 'TAVILY_API_KEY';
  }
}

export async function POST(req: NextRequest) {
  let query: string | undefined;
  try {
    const body = await req.json();
    const {
      query: requestQuery,
      pdfText,
      providerId: requestProviderId,
      apiKey: clientApiKey,
      baseUrl: clientBaseUrl,
      baiduSubSources,
    } = body as {
      query?: string;
      pdfText?: string;
      providerId?: WebSearchProviderId;
      apiKey?: string;
      baseUrl?: string;
      baiduSubSources?: BaiduSubSources;
    };
    query = requestQuery;

    if (!query || !query.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'query is required');
    }

    const providerId: WebSearchProviderId =
      requestProviderId && WEB_SEARCH_PROVIDERS[requestProviderId] ? requestProviderId : 'tavily';

    if (!isProviderEnabled(providerId)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Web search provider '${providerId}' is disabled. Set WEB_SEARCH_${providerId.toUpperCase()}_ENABLED=true on the server to opt in.`,
      );
    }

    const provider = WEB_SEARCH_PROVIDERS[providerId];

    // Managed-mode: ignore client-supplied apiKey/baseUrl, log the bypass.
    let effectiveClientApiKey = clientApiKey;
    let effectiveClientBaseUrl = clientBaseUrl;
    if (isManagedProviderMode()) {
      if (clientApiKey || clientBaseUrl) {
        logManagedModeBypass({
          route: 'web-search',
          header: clientBaseUrl ? 'body.baseUrl' : 'body.apiKey',
          value: providerId,
        });
      }
      effectiveClientApiKey = undefined;
      effectiveClientBaseUrl = undefined;
    }

    const apiKey = resolveWebSearchApiKey(providerId, effectiveClientApiKey);
    if (provider.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        400,
        `${provider.name} API key is not configured. Set it in Settings -> Web Search or configure ${getWebSearchEnvKey(providerId)} on the server.`,
      );
    }

    let baseUrl: string | undefined;
    try {
      baseUrl = resolveWebSearchRouteBaseUrl(providerId, effectiveClientBaseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid web search base URL';
      return apiError('INVALID_REQUEST', 400, message);
    }

    // Bound rewrite input at the route boundary; framework body limits still
    // apply to the total request size.
    const boundedPdfText = pdfText?.slice(0, SEARCH_QUERY_REWRITE_EXCERPT_LENGTH);

    // Build LLM-driven query rewrite call when needed (long requirement / PDF).
    let aiCall: AICallFn | undefined;
    try {
      const resolved = resolveModelFromHeaders(req);
      aiCall = async (systemPrompt, userPrompt) => {
        const result = await callLLM(
          {
            model: resolved.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            maxOutputTokens: 256,
          },
          'web-search-query-rewrite',
        );
        return result.text;
      };
    } catch (error) {
      log.warn('Search query rewrite model unavailable, falling back to raw requirement:', error);
    }

    const searchQuery = await buildSearchQuery(query, boundedPdfText, aiCall);

    log.info('Running web search API request', {
      providerId,
      hasPdfContext: searchQuery.hasPdfContext,
      rawRequirementLength: searchQuery.rawRequirementLength,
      rewriteAttempted: searchQuery.rewriteAttempted,
      finalQueryLength: searchQuery.finalQueryLength,
    });

    const result = await searchWeb({
      providerId,
      query: searchQuery.query,
      apiKey,
      baseUrl,
      ...(providerId === 'baidu' && baiduSubSources ? { baiduSubSources } : {}),
    });
    const context = formatSearchResultsAsContext(result);

    return apiSuccess({
      answer: result.answer,
      sources: result.sources,
      context,
      query: result.query,
      responseTime: result.responseTime,
    });
  } catch (err) {
    log.error(`Web search failed [query="${query?.substring(0, 60) ?? 'unknown'}"]:`, err);
    const message = err instanceof Error ? err.message : 'Web search failed';
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
