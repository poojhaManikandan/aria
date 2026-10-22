import { NextResponse } from 'next/server';
import { bus } from '@/server/bus';

/**
 * POST /api/telemetry/reset — clears the in-memory telemetry backlog so a
 * judge can run a clean demo without restarting the server.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  bus.reset();
  return NextResponse.json({ ok: true });
}
