/**
 * Shared model resolution utilities for API routes.
 *
 * Extracts the repeated parseModelString → resolveApiKey → resolveBaseUrl →
 * resolveProxy → getModel boilerplate into a single call.
 */

import type { NextRequest } from 'next/server';
import { getModel, parseModelString, type ModelWithInfo } from '@/lib/ai/providers';
import { resolveApiKey, resolveBaseUrl, resolveProxy } from '@/lib/server/provider-config';
import { validateUrlForSSRFSync } from '@/lib/server/ssrf-guard';
import { isManagedProviderMode, logManagedModeBypass } from '@/lib/server/managed-mode';
import { createLogger } from '@/lib/logger';

const log = createLogger('ResolveModel');

export interface ResolvedModel extends ModelWithInfo {
  /** Original model string (e.g. "openai/gpt-4o-mini") */
  modelString: string;
  /** Effective API key after server-side fallback resolution */
  apiKey: string;
}

/**
 * Resolve a language model from explicit parameters.
 *
 * Use this when model config comes from the request body.
 */
export function resolveModel(params: {
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
}): ResolvedModel {
  const managed = isManagedProviderMode();
  const serverDefault = process.env.DEFAULT_MODEL || '';

  // In managed mode, ignore client-supplied model — the server's DEFAULT_MODEL
  // is authoritative. This prevents a stale client-state (e.g. "gpt-5.2")
  // from reaching the proxy with a model name the ai-gateway does not expose.
  let modelString: string;
  if (managed && serverDefault) {
    if (params.modelString && params.modelString !== serverDefault) {
      log.warn('Client model overridden in managed mode', {
        clientModel: params.modelString,
        serverDefault,
      });
    }
    modelString = serverDefault;
  } else {
    modelString = params.modelString || serverDefault || 'gpt-4o-mini';
  }

  const { providerId, modelId } = parseModelString(modelString);

  // In managed mode, ignore any client-supplied credentials.
  // Server-configured providers are authoritative.
  let clientBaseUrl = params.baseUrl || undefined;
  let clientApiKey = params.apiKey || undefined;

  if (managed && (clientBaseUrl || clientApiKey)) {
    logManagedModeBypass({
      route: 'resolveModel',
      header: clientBaseUrl ? 'baseUrl' : 'apiKey',
      value: clientBaseUrl || clientApiKey,
    });
    clientBaseUrl = undefined;
    clientApiKey = undefined;
  }

  if (clientBaseUrl && process.env.NODE_ENV === 'production') {
    const ssrfError = validateUrlForSSRFSync(clientBaseUrl);
    if (ssrfError) {
      throw new Error(ssrfError);
    }
  }

  const apiKey = clientBaseUrl
    ? clientApiKey || ''
    : resolveApiKey(providerId, clientApiKey || '');
  const baseUrl = clientBaseUrl ? clientBaseUrl : resolveBaseUrl(providerId, params.baseUrl);
  const proxy = resolveProxy(providerId);
  const { model, modelInfo } = getModel({
    providerId,
    modelId,
    apiKey,
    baseUrl,
    proxy,
    providerType: params.providerType as 'openai' | 'anthropic' | 'google' | undefined,
    requiresApiKey: params.requiresApiKey,
  });

  return { model, modelInfo, modelString, apiKey };
}

/**
 * Resolve a language model from standard request headers.
 *
 * Reads: x-model, x-api-key, x-base-url, x-provider-type, x-requires-api-key
 */
export function resolveModelFromHeaders(req: NextRequest): ResolvedModel {
  // In managed mode, strip provider credentials from headers.
  const managed = isManagedProviderMode();
  const clientApiKey = req.headers.get('x-api-key') || undefined;
  const clientBaseUrl = req.headers.get('x-base-url') || undefined;

  if (managed && (clientApiKey || clientBaseUrl)) {
    logManagedModeBypass({
      route: 'resolveModelFromHeaders',
      header: clientBaseUrl ? 'x-base-url' : 'x-api-key',
      value: clientBaseUrl || clientApiKey,
    });
  }

  return resolveModel({
    modelString: req.headers.get('x-model') || undefined,
    apiKey: managed ? undefined : clientApiKey,
    baseUrl: managed ? undefined : clientBaseUrl,
    providerType: req.headers.get('x-provider-type') || undefined,
    requiresApiKey: req.headers.get('x-requires-api-key') === 'true' ? true : undefined,
  });
}
