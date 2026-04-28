import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { isManagedProviderMode } from '@/lib/server/managed-mode';
import {
  getServerImageProviders,
  getServerVideoProviders,
} from '@/lib/server/provider-config';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    const managed = isManagedProviderMode();
    const hasServerImage = managed && Object.keys(getServerImageProviders()).length > 0;
    const hasServerVideo = managed && Object.keys(getServerVideoProviders()).length > 0;
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),
      ...(rawBody.language ? { language: rawBody.language } : {}),
      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      // Explicit `false` from caller wins even in managed mode — host operators
      // (e.g. osvaivai feature flags) need a hard kill-switch for media.
      ...(rawBody.enableImageGeneration === false
        ? { enableImageGeneration: false }
        : hasServerImage
          ? { enableImageGeneration: true }
          : rawBody.enableImageGeneration != null
            ? { enableImageGeneration: rawBody.enableImageGeneration }
            : {}),
      ...(rawBody.enableVideoGeneration === false
        ? { enableVideoGeneration: false }
        : hasServerVideo
          ? { enableVideoGeneration: true }
          : rawBody.enableVideoGeneration != null
            ? { enableVideoGeneration: rawBody.enableVideoGeneration }
            : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
      ...(rawBody.modelString ? { modelString: rawBody.modelString } : {}),
      ...(rawBody.generationProfile ? { generationProfile: rawBody.generationProfile } : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
