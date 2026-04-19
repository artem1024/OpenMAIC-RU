/**
 * Tests for managed provider mode in resolve-model.ts
 *
 * Verifies that when MANAGED_PROVIDER_MODE is set, client-supplied
 * baseUrl and apiKey are ignored (both body-based and header-based paths).
 *
 * See remediation-plan-v3 A.2.5.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the providers module before importing resolve-model
vi.mock('@/lib/ai/providers', () => ({
  parseModelString: (s: string) => {
    const [providerId, modelId] = s.includes(':') ? s.split(':') : ['openai', s];
    return { providerId, modelId };
  },
  getModel: (opts: Record<string, unknown>) => ({
    model: { id: opts.modelId },
    modelInfo: { id: opts.modelId },
  }),
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveApiKey: (_pid: string, fallback: string) => fallback || 'server-key-from-env',
  resolveBaseUrl: (_pid: string, _fb?: string) => 'https://server-base.example.com',
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRFSync: (url: string) => {
    if (url.includes('evil')) return 'Blocked by SSRF';
    return null;
  },
}));

describe('resolve-model managed mode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadResolveModel() {
    // Dynamic import to pick up fresh env each test
    return await import('@/lib/server/resolve-model');
  }

  test('non-managed: client baseUrl and apiKey are used', async () => {
    delete process.env.MANAGED_PROVIDER_MODE;
    const { resolveModel } = await loadResolveModel();

    const result = resolveModel({
      modelString: 'openai:gpt-4o',
      apiKey: 'client-key',
      baseUrl: 'https://client-custom.example.com',
    });

    expect(result.apiKey).toBe('client-key');
  });

  test('managed: client baseUrl and apiKey are ignored', async () => {
    process.env.MANAGED_PROVIDER_MODE = '1';
    const { resolveModel } = await loadResolveModel();

    const result = resolveModel({
      modelString: 'openai:gpt-4o',
      apiKey: 'client-key',
      baseUrl: 'https://client-custom.example.com',
    });

    // Should use server-resolved key, not client-supplied
    expect(result.apiKey).toBe('server-key-from-env');
  });

  test('managed with "true" value: also works', async () => {
    process.env.MANAGED_PROVIDER_MODE = 'true';
    const { resolveModel } = await loadResolveModel();

    const result = resolveModel({
      modelString: 'openai:gpt-4o',
      apiKey: 'client-key',
    });

    expect(result.apiKey).toBe('server-key-from-env');
  });

  test('managed: no baseUrl means no SSRF check on request path', async () => {
    process.env.MANAGED_PROVIDER_MODE = '1';
    process.env.NODE_ENV = 'production';
    const { resolveModel } = await loadResolveModel();

    // In non-managed mode, this would trigger SSRF check on "evil" URL
    // In managed mode, the URL is stripped so SSRF check is never reached
    expect(() =>
      resolveModel({
        modelString: 'openai:gpt-4o',
        apiKey: 'client-key',
        baseUrl: 'https://evil.example.com',
      })
    ).not.toThrow();
  });

  test('non-managed + production: SSRF check fires on suspicious baseUrl', async () => {
    delete process.env.MANAGED_PROVIDER_MODE;
    process.env.NODE_ENV = 'production';
    const { resolveModel } = await loadResolveModel();

    expect(() =>
      resolveModel({
        modelString: 'openai:gpt-4o',
        baseUrl: 'https://evil.example.com',
      })
    ).toThrow('Blocked by SSRF');
  });

  test('managed: resolveModelFromHeaders strips x-base-url and x-api-key', async () => {
    process.env.MANAGED_PROVIDER_MODE = '1';
    const { resolveModelFromHeaders } = await loadResolveModel();

    // Create a mock NextRequest
    const headers = new Headers({
      'x-model': 'openai:gpt-4o',
      'x-api-key': 'client-header-key',
      'x-base-url': 'https://client-custom.example.com',
    });
    const req = { headers } as unknown as import('next/server').NextRequest;

    const result = resolveModelFromHeaders(req);

    // Server-resolved key, not client key
    expect(result.apiKey).toBe('server-key-from-env');
  });

  test('non-managed: resolveModelFromHeaders passes x-api-key through', async () => {
    delete process.env.MANAGED_PROVIDER_MODE;
    const { resolveModelFromHeaders } = await loadResolveModel();

    const headers = new Headers({
      'x-model': 'openai:gpt-4o',
      'x-api-key': 'client-header-key',
    });
    const req = { headers } as unknown as import('next/server').NextRequest;

    const result = resolveModelFromHeaders(req);

    expect(result.apiKey).toBe('client-header-key');
  });

  test('managed: client modelString is overridden by DEFAULT_MODEL', async () => {
    process.env.MANAGED_PROVIDER_MODE = '1';
    process.env.DEFAULT_MODEL = 'openai:llm';
    const { resolveModel } = await loadResolveModel();

    const result = resolveModel({ modelString: 'openai:gpt-5.2' });

    expect(result.modelString).toBe('openai:llm');
  });

  test('non-managed: client modelString wins even if DEFAULT_MODEL is set', async () => {
    delete process.env.MANAGED_PROVIDER_MODE;
    process.env.DEFAULT_MODEL = 'openai:llm';
    const { resolveModel } = await loadResolveModel();

    const result = resolveModel({ modelString: 'openai:gpt-5.2' });

    expect(result.modelString).toBe('openai:gpt-5.2');
  });

  test('managed without DEFAULT_MODEL: falls back to client model (no server default to enforce)', async () => {
    process.env.MANAGED_PROVIDER_MODE = '1';
    delete process.env.DEFAULT_MODEL;
    const { resolveModel } = await loadResolveModel();

    const result = resolveModel({ modelString: 'openai:gpt-5.2' });

    expect(result.modelString).toBe('openai:gpt-5.2');
  });
});
