'use client';

/**
 * Hook for reading the server's public environment config.
 *
 * Fetches /api/env/public-config once per page load and caches the result.
 * Used by frontend code to conditionally omit provider credentials
 * when the server is in managed provider mode.
 *
 * See remediation-plan-v3 A.2.3 / A.2.4.
 */

import { useState, useEffect } from 'react';

interface PublicConfig {
  managedMode: boolean;
}

let cachedConfig: PublicConfig | null = null;
let fetchPromise: Promise<PublicConfig> | null = null;

/**
 * Fetch and cache the public config. Safe to call multiple times;
 * only one network request is made.
 */
async function fetchPublicConfig(): Promise<PublicConfig> {
  if (cachedConfig) return cachedConfig;
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/env/public-config')
    .then(async (res) => {
      if (!res.ok) return { managedMode: false };
      const data = await res.json();
      cachedConfig = { managedMode: !!data.managedMode };
      return cachedConfig;
    })
    .catch(() => {
      // Fail-open: if we can't reach the endpoint, assume non-managed.
      return { managedMode: false };
    })
    .finally(() => {
      fetchPromise = null;
    });

  return fetchPromise;
}

/**
 * Returns true if the server is in managed mode.
 *
 * On first call (before the fetch completes), returns false (optimistic).
 * Once the config is fetched, the hook reactively updates.
 */
export function usePublicConfig(): PublicConfig {
  const [config, setConfig] = useState<PublicConfig>(cachedConfig ?? { managedMode: false });

  useEffect(() => {
    fetchPublicConfig().then((c) => setConfig(c));
  }, []);

  return config;
}

/**
 * Synchronous accessor for the cached managed mode flag.
 *
 * Use from non-hook contexts (e.g. plain functions called from event handlers).
 * Returns false until the fetch has completed.
 * Kicks off a background fetch if not yet started.
 */
export function isManagedModeClient(): boolean {
  if (cachedConfig) return cachedConfig.managedMode;
  // Kick off background fetch if not started
  fetchPublicConfig();
  return false;
}
