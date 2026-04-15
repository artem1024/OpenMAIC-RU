/**
 * Managed Provider Mode utilities.
 *
 * When MANAGED_PROVIDER_MODE is enabled (env '1' or 'true'), the server
 * refuses client-supplied provider credentials (x-api-key, x-base-url,
 * baseUrl). All provider configuration comes exclusively from server-side
 * env vars / server-providers.yml.
 *
 * See remediation-plan-v3 A.2 / P1.6.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('ManagedMode');

/**
 * Returns true when the server is in managed provider mode.
 *
 * Reads `MANAGED_PROVIDER_MODE` env var (accepts '1' or 'true',
 * case-insensitive).
 */
export function isManagedProviderMode(): boolean {
  const raw = process.env.MANAGED_PROVIDER_MODE;
  if (!raw) return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Log a structured warning when a client attempts to supply provider
 * credentials in managed mode. Called from server routes that receive
 * x-base-url / x-api-key / baseUrl.
 */
export function logManagedModeBypass(params: {
  route: string;
  header?: string;
  value?: string;
}): void {
  log.warn('Client-supplied provider credential ignored in managed mode', {
    source: 'managed-mode-bypass',
    route: params.route,
    header: params.header,
    // Redact actual value to avoid leaking secrets in logs
    valuePresent: !!params.value,
  });
}
