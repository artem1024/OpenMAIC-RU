/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (default: 'seedream')
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { generateImage, aspectRatioToDimensions } from '@/lib/media/image-providers';
import {
  resolveImageApiKey,
  resolveImageBaseUrl,
  getServerImageProviders,
} from '@/lib/server/provider-config';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { isManagedProviderMode, logManagedModeBypass } from '@/lib/server/managed-mode';

const log = createLogger('ImageGeneration API');

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const idempotencyKey = request.headers.get('idempotency-key');
    if (idempotencyKey) log.info(`Idempotency-Key: ${idempotencyKey}`);

    const body = (await request.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    let providerId = (request.headers.get('x-image-provider') || 'seedream') as ImageProviderId;
    const managed = isManagedProviderMode();
    let clientApiKey = request.headers.get('x-api-key') || undefined;
    let clientBaseUrl = request.headers.get('x-base-url') || undefined;
    const clientModel = request.headers.get('x-image-model') || undefined;

    if (managed) {
      if (clientApiKey || clientBaseUrl) {
        logManagedModeBypass({
          route: '/api/generate/image',
          header: clientBaseUrl ? 'x-base-url' : 'x-api-key',
          value: clientBaseUrl || clientApiKey,
        });
        clientApiKey = undefined;
        clientBaseUrl = undefined;
      }
      const serverIds = Object.keys(getServerImageProviders()) as ImageProviderId[];
      if (serverIds.length > 0 && !serverIds.includes(providerId)) {
        log.info(
          `Managed mode: overriding client image provider "${providerId}" → "${serverIds[0]}"`,
        );
        providerId = serverIds[0];
      }
    }

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = clientBaseUrl
      ? clientApiKey || ''
      : resolveImageApiKey(providerId, clientApiKey);
    if (!apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }

    const baseUrl = clientBaseUrl ? clientBaseUrl : resolveImageBaseUrl(providerId, clientBaseUrl);

    // Resolve dimensions from aspect ratio if not explicitly set
    if (!body.width && !body.height && body.aspectRatio) {
      const dims = aspectRatioToDimensions(body.aspectRatio);
      body.width = dims.width;
      body.height = dims.height;
    }

    log.info(
      `Generating image: provider=${providerId}, model=${clientModel || 'default'}, ` +
        `prompt="${body.prompt.slice(0, 80)}...", size=${body.width ?? 'auto'}x${body.height ?? 'auto'}`,
    );

    const result = await generateImage({ providerId, apiKey, baseUrl, model: clientModel }, body);

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error('Image generation error:', error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
