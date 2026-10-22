import { NextResponse } from 'next/server';
import { processTurn } from '@/server/pipeline';
import type { ChatMessage, GroundingParam } from '@/lib/types';

const GROUNDING_PARAMS: readonly GroundingParam[] = ['ORDER_ID', 'ITEM_SKU', 'REASON'];

/**
 * POST /api/chat
 *
 * Runs one customer turn through the Layer 1 → Layer 2 → Layer 3 pipeline.
 * The response contains the finished assistant reply, the full decision trace
 * and every telemetry event produced by the turn (the same events are also
 * pushed live over /api/telemetry/stream).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Hard limits that keep an abusive client from exhausting the pipeline. */
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 12;

interface ChatRequestBody {
  message?: string;
  history?: ChatMessage[];
}

/** Accept only well-formed user/assistant turns, newest-last. */
function sanitiseHistory(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];

  return input
    .filter((item): item is ChatMessage => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<ChatMessage>;
      return (
        (candidate.role === 'user' || candidate.role === 'assistant') &&
        typeof candidate.content === 'string'
      );
    })
    .slice(-MAX_HISTORY_TURNS)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : 'history',
      role: item.role,
      content: item.content.slice(0, MAX_MESSAGE_CHARS),
      ts: typeof item.ts === 'number' ? item.ts : Date.now(),
      // Preserve the slots the agent asked for — Layer 2 depends on this to
      // decide whether chat-context grounding is permitted.
      requests: Array.isArray(item.requests)
        ? item.requests.filter((p): p is GroundingParam =>
            GROUNDING_PARAMS.includes(p as GroundingParam),
          )
        : undefined,
      // Preserve the slots that were already grounded, so a clarification
      // exchange can carry a resolved value across its turns.
      resolved:
        item.resolved && typeof item.resolved === 'object'
          ? (Object.fromEntries(
              GROUNDING_PARAMS.filter((param) => {
                const value = (item.resolved as Record<string, unknown>)[param];
                return typeof value === 'string' && value.length > 0;
              }).map((param) => [
                param,
                (item.resolved as Record<string, string>)[param],
              ]),
            ) as Partial<Record<GroundingParam, string>>)
          : undefined,
    }));
}

export async function POST(request: Request) {
  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const message = String(body?.message ?? '').trim();

  if (!message) {
    return NextResponse.json({ error: 'Message must not be empty.' }, { status: 400 });
  }

  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `Message exceeds the ${MAX_MESSAGE_CHARS} character limit.` },
      { status: 413 },
    );
  }

  const { trace, events } = await processTurn({
    message,
    history: sanitiseHistory(body?.history),
  });

  return NextResponse.json({ trace, events });
}
