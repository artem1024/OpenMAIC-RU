import { useSettingsStore } from '@/lib/store/settings';
import { isManagedModeClient } from '@/lib/hooks/use-public-config';

/**
 * Get current model configuration from settings store.
 *
 * In managed provider mode, apiKey and baseUrl are omitted so
 * the browser never sends provider credentials to the server.
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig } = useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];

  const managed = isManagedModeClient();

  return {
    providerId,
    modelId,
    modelString,
    apiKey: managed ? '' : (providerConfig?.apiKey || ''),
    baseUrl: managed ? '' : (providerConfig?.baseUrl || ''),
    providerType: providerConfig?.type,
    requiresApiKey: managed ? false : providerConfig?.requiresApiKey,
    isServerConfigured: managed ? true : providerConfig?.isServerConfigured,
  };
}
