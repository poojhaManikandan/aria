import { bus } from '@/server/bus';
import type { TelemetryEvent } from '@/lib/types';

/**
 * GET /api/telemetry/stream
 *
 * Server-Sent Events stream of every decision-engine event. The dashboard
 * subscribes once and renders the pipeline in real time.
 *
 * The stream replays the recent backlog on connect so a late subscriber (or a
 * page refresh) is never missing context.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function frame(event: TelemetryEvent): Uint8Array {
  return encoder.encode(`event: telemetry\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function GET(request: Request) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      // 1) Backlog replay so the panel opens with context.
      for (const event of bus.history()) {
        safeEnqueue(frame(event));
      }

      // 2) Live subscription.
      const unsubscribe = bus.subscribe((event) => safeEnqueue(frame(event)));

      // 3) Heartbeat keeps proxies and the browser from idling the socket out.
      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
