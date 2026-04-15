/**
 * Shared helpers for provider connectivity checks.
 *
 * Goal (see remediation-plan-v3 P0.4):
 *   - `success` must mean the endpoint is reachable AND is actually the expected provider.
 *   - HTTP 400/404/500 from an unrelated server (e.g. an internal stub) must NOT be
 *     reported as "Connected".
 *
 * Strategy:
 *   - A 2xx response with a JSON body that includes at least one of the provider's
 *     known shape keys = confirmed.
 *   - A 4xx response (other than 401/403) with a JSON error body containing one of
 *     the provider's known error markers = also confirmed (the provider spoke, just
 *     rejected the intentionally-empty probe).
 *   - Everything else (non-JSON body, unknown shape, network error, or 5xx without a
 *     provider-specific error body) = not confirmed.
 */

export interface ProviderCheckOptions {
  /** Expected keys in a successful JSON body, any of which confirms the provider. */
  okKeys?: string[];
  /** Expected keys in a JSON error body (4xx), any of which confirms the provider. */
  errorKeys?: string[];
  /**
   * Case-insensitive markers that may appear anywhere in the JSON-stringified body
   * to confirm the provider (e.g. an error code prefix or a Google "status" string).
   */
  markers?: string[];
}

export interface ProviderCheckResult {
  confirmed: boolean;
  status: number;
  raw: unknown;
}

/**
 * Inspect a fetch Response and decide whether it proves we talked to the right provider.
 */
export async function isResponseFromExpectedProvider(
  response: Response,
  opts: ProviderCheckOptions,
): Promise<ProviderCheckResult> {
  const status = response.status;
  const contentType = response.headers.get('content-type') || '';

  let raw: unknown = null;
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    return { confirmed: false, status, raw: null };
  }

  // Only structured JSON bodies are trustworthy signals.
  if (!contentType.toLowerCase().includes('json')) {
    return { confirmed: false, status, raw: bodyText };
  }
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return { confirmed: false, status, raw: bodyText };
  }

  if (!raw || typeof raw !== 'object') {
    return { confirmed: false, status, raw };
  }

  const serialized = bodyText.toLowerCase();
  const markers = opts.markers ?? [];
  const hasMarker = markers.some((m) => serialized.includes(m.toLowerCase()));

  const flatKeys = collectKeys(raw, 3);
  const wanted = new Set<string>([...(opts.okKeys ?? []), ...(opts.errorKeys ?? [])]);
  const hasKey = [...wanted].some((k) => flatKeys.has(k));

  const confirmed = hasKey || hasMarker;
  return { confirmed, status, raw };
}

function collectKeys(value: unknown, depth: number, acc: Set<string> = new Set()): Set<string> {
  if (depth < 0 || !value || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, depth - 1, acc);
    return acc;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    acc.add(k);
    collectKeys((value as Record<string, unknown>)[k], depth - 1, acc);
  }
  return acc;
}

/**
 * Standard shape for connectivity results used across adapters.
 */
export interface ConnectivityResult {
  success: boolean;
  message: string;
}

/**
 * Format a deny message when the response did not confirm the provider.
 */
export function providerMismatchMessage(provider: string, status: number): string {
  return (
    `${provider} connectivity check failed: endpoint returned HTTP ${status} ` +
    `but response did not match the expected ${provider} shape. ` +
    `Verify baseUrl points to the real ${provider} API.`
  );
}
