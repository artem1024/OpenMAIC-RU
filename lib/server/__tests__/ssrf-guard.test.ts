import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateUrlForSSRF,
  validateUrlForSSRFSync,
  decodeAlternativeIPv4,
  __ssrfGuardInternals,
} from '@/lib/server/ssrf-guard';

const { isBlockedIPv4, isBlockedIPv6 } = __ssrfGuardInternals();

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: {
      lookup: vi.fn(),
    },
  };
});

import { promises as dns } from 'node:dns';
const dnsLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  dnsLookup.mockReset();
});

function mockDns(map: Record<string, Array<{ address: string; family: 4 | 6 }>>) {
  dnsLookup.mockImplementation(async (host: string, _opts: any) => {
    const entries = map[host];
    if (!entries) {
      const err: any = new Error(`ENOTFOUND ${host}`);
      err.code = 'ENOTFOUND';
      throw err;
    }
    return entries;
  });
}

describe('decodeAlternativeIPv4', () => {
  it('decodes decimal 2130706433 -> 127.0.0.1', () => {
    expect(decodeAlternativeIPv4('2130706433')).toBe('127.0.0.1');
  });
  it('decodes hex 0x7f000001 -> 127.0.0.1', () => {
    expect(decodeAlternativeIPv4('0x7f000001')).toBe('127.0.0.1');
  });
  it('decodes octal octets 0177.0.0.1 -> 127.0.0.1', () => {
    expect(decodeAlternativeIPv4('0177.0.0.1')).toBe('127.0.0.1');
  });
  it('decodes short form 127.1 -> 127.0.0.1', () => {
    expect(decodeAlternativeIPv4('127.1')).toBe('127.0.0.1');
  });
  it('returns null for normal hostnames', () => {
    expect(decodeAlternativeIPv4('api.openai.com')).toBeNull();
  });
});

describe('isBlockedIPv4', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1'])('allows %s', (ip) => {
    expect(isBlockedIPv4(ip)).toBe(false);
  });
});

describe('isBlockedIPv6', () => {
  it.each(['::1', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'blocks %s',
    (ip) => {
      expect(isBlockedIPv6(ip)).toBe(true);
    },
  );

  it('allows public IPv6', () => {
    expect(isBlockedIPv6('2001:4860:4860::8888')).toBe(false);
  });

  it('blocks IPv4-mapped private', () => {
    expect(isBlockedIPv6('::ffff:10.0.0.1')).toBe(true);
  });
});

describe('validateUrlForSSRF (async, with DNS)', () => {
  it('blocks http://127.0.0.1:8000/', async () => {
    expect(await validateUrlForSSRF('http://127.0.0.1:8000/')).not.toBeNull();
  });

  it('blocks http://127.1/', async () => {
    expect(await validateUrlForSSRF('http://127.1/')).not.toBeNull();
  });

  it('blocks http://2130706433/', async () => {
    expect(await validateUrlForSSRF('http://2130706433/')).not.toBeNull();
  });

  it('blocks http://0x7f000001/', async () => {
    expect(await validateUrlForSSRF('http://0x7f000001/')).not.toBeNull();
  });

  it('blocks http://[::1]/', async () => {
    expect(await validateUrlForSSRF('http://[::1]/')).not.toBeNull();
  });

  it('blocks http://[::ffff:127.0.0.1]/', async () => {
    expect(await validateUrlForSSRF('http://[::ffff:127.0.0.1]/')).not.toBeNull();
  });

  it('blocks http://backend:8000/ when it resolves to a private IP', async () => {
    mockDns({ backend: [{ address: '172.18.0.5', family: 4 }] });
    expect(await validateUrlForSSRF('http://backend:8000/')).not.toBeNull();
  });

  it('blocks http://openmaic-ru-openmaic-1:3000/ when it resolves to a private IP', async () => {
    mockDns({ 'openmaic-ru-openmaic-1': [{ address: '172.18.0.7', family: 4 }] });
    expect(await validateUrlForSSRF('http://openmaic-ru-openmaic-1:3000/')).not.toBeNull();
  });

  it('blocks http://169.254.169.254/ (cloud metadata)', async () => {
    expect(await validateUrlForSSRF('http://169.254.169.254/')).not.toBeNull();
  });

  it('blocks non-http(s) schemes', async () => {
    expect(await validateUrlForSSRF('file:///etc/passwd')).not.toBeNull();
    expect(await validateUrlForSSRF('gopher://127.0.0.1/')).not.toBeNull();
  });

  it('allows https://api.openai.com/', async () => {
    mockDns({ 'api.openai.com': [{ address: '162.159.140.229', family: 4 }] });
    expect(await validateUrlForSSRF('https://api.openai.com/')).toBeNull();
  });

  it('allows https://generativelanguage.googleapis.com/', async () => {
    mockDns({
      'generativelanguage.googleapis.com': [{ address: '142.250.185.106', family: 4 }],
    });
    expect(await validateUrlForSSRF('https://generativelanguage.googleapis.com/')).toBeNull();
  });

  it('blocks when any of the resolved IPs is private (dual-stack)', async () => {
    mockDns({
      'evil.example.com': [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    expect(await validateUrlForSSRF('https://evil.example.com/')).not.toBeNull();
  });
});

describe('validateUrlForSSRFSync (no DNS)', () => {
  it('blocks IP literals', () => {
    expect(validateUrlForSSRFSync('http://127.0.0.1/')).not.toBeNull();
    expect(validateUrlForSSRFSync('http://[::1]/')).not.toBeNull();
    expect(validateUrlForSSRFSync('http://0x7f000001/')).not.toBeNull();
    expect(validateUrlForSSRFSync('http://2130706433/')).not.toBeNull();
  });

  it('blocks localhost variants', () => {
    expect(validateUrlForSSRFSync('http://localhost/')).not.toBeNull();
    expect(validateUrlForSSRFSync('http://anything.local/')).not.toBeNull();
  });

  it('blocks bare single-label hostnames (docker service name pattern)', () => {
    expect(validateUrlForSSRFSync('http://backend:8000/')).not.toBeNull();
  });

  it('allows public domains', () => {
    expect(validateUrlForSSRFSync('https://api.openai.com/v1/')).toBeNull();
  });

  it('rejects non-http(s)', () => {
    expect(validateUrlForSSRFSync('javascript:alert(1)')).not.toBeNull();
  });
});
