import { createHmac } from 'node:crypto';

import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

/**
 * Build HMAC-SHA256 signature over `${timestamp}.${body}`.
 * See remediation-plan-v3 P1.5.
 */
function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);

      // Отправить webhook в витрину Осваивай, если настроен.
      // DEPRECATED: ранее слался только X-Webhook-Secret без подписи тела;
      // теперь — X-Timestamp + X-Signature = HMAC(secret, timestamp + "." + body).
      // См. remediation-plan-v3 P1.5.
      const webhookUrl = process.env.OSVAIVAI_WEBHOOK_URL;
      if (webhookUrl) {
        try {
          const secret = process.env.OSVAIVAI_WEBHOOK_SECRET || '';
          // Backwards-compatible: исходные поля сохранены, добавлены опциональные
          // timings/config (см. GenerationTimings/GenerationConfigSnapshot). Старые
          // консьюмеры просто игнорируют новые ключи.
          const body = JSON.stringify({
            jobId: jobId,
            classroomId: result.id,
            title: result.stage?.name || '',
            scenesCount: result.scenesCount,
            htmlPath: result.url || null,
            timings: result.timings ?? null,
            config: result.config ?? null,
          });
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const signature = secret ? signWebhookBody(secret, timestamp, body) : '';
          await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Secret': secret,
              'X-Timestamp': timestamp,
              'X-Signature': signature,
            },
            body,
          });
        } catch (webhookError) {
          log.warn('Webhook to osvaivai failed:', webhookError);
          // Не блокируем основной flow
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
