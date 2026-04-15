/**
 * Public Config API
 *
 * Exposes non-secret, environment-derived flags to the frontend.
 * The frontend reads this on startup to adjust its behaviour
 * (e.g. suppress sending provider credentials in managed mode).
 *
 * GET /api/env/public-config
 * Response: { managedMode: boolean }
 *
 * See remediation-plan-v3 A.2.3.
 */

import { NextResponse } from 'next/server';
import { isManagedProviderMode } from '@/lib/server/managed-mode';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    managedMode: isManagedProviderMode(),
  });
}
