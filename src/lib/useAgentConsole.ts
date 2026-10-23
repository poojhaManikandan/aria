'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, GroundingParam, PipelineTrace, SessionMetrics, TelemetryEvent } from './types';
import { aggregateMetrics, deriveLiveState, type LiveState } from './live-state';

/** Small id generator that works in every browser context. */
function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const GREETING: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  ts: Date.now(),
  content:
    "Hi — I'm Aria, the autonomous e-commerce support agent.\n\n" +
    'Every message you send is screened by **Strands Decider 2B** before it reaches me. ' +
    'If your request is safe and fully specified, I act on it instantly. If it looks like an attack ' +
    'or a refund is missing required details, I stop and ask instead.',
};

export interface AgentConsoleApi {
  messages: ChatMessage[];
  traces: PipelineTrace[];
  events: TelemetryEvent[];
  live: LiveState;
  metrics: SessionMetrics;
  connected: boolean;
  busy: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  reset: () => Promise<void>;
}

/**
 * Central client store for the console.
 *
 * Two channels feed the dashboard:
 *   • SSE (/api/telemetry/stream) — live decision-engine events.
 *   • POST (/api/chat)             — the finished reply + the full trace.
 *
 * Both are merged through a de-duplication set keyed on the event id, so the
 * panel can never show an event twice and never misses one.
 */
export function useAgentConsole(): AgentConsoleApi {
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [traces, setTraces] = useState<PipelineTrace[]>([]);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Ids of every event already ingested (SSE + HTTP). */
  const seenEventIds = useRef<Set<string>>(new Set());
  const sourceRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<ChatMessage[]>([GREETING]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** Merge a batch of events, ignoring duplicates and capping the buffer. */
  const ingest = useCallback((incoming: TelemetryEvent[]) => {
    const fresh = incoming.filter((event) => {
      if (seenEventIds.current.has(event.id)) return false;
      seenEventIds.current.add(event.id);
      return true;
    });
    if (fresh.length === 0) return;
    setEvents((prev) => {
      const next = [...prev, ...fresh];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  /* ------------------------------------------------------------------ */
  /* Live telemetry subscription                                        */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      const source = new EventSource('/api/telemetry/stream');
      sourceRef.current = source;

      source.addEventListener('open', () => setConnected(true));

      source.addEventListener('telemetry', (raw) => {
        try {
          ingest([JSON.parse((raw as MessageEvent).data) as TelemetryEvent]);
        } catch {
          /* malformed frame — ignore */
        }
      });

      source.addEventListener('error', () => {
        setConnected(false);
        source.close();
        // The EventSource auto-reconnects, but we recreate it explicitly so
        // a dropped server-side subscription is always re-established.
        if (!closed) retry = setTimeout(connect, 2500);
      });
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [ingest]);

  /* ------------------------------------------------------------------ */
  /* Send a turn                                                        */
  /* ------------------------------------------------------------------ */
  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || busy) return;

      setError(null);
      setBusy(true);

      const userMessage: ChatMessage = {
        id: makeId('u'),
        role: 'user',
        content: text,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // The grounding layer re-reads the whole customer-side context.
      const history = [...messagesRef.current, userMessage];

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history }),
        });

        if (!response.ok) {
          const failure = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(failure?.error ?? `Pipeline returned ${response.status}`);
        }

        const payload = (await response.json()) as {
          trace: PipelineTrace;
          events: TelemetryEvent[];
        };

        ingest(payload.events ?? []);
        setTraces((prev) => [...prev, payload.trace]);

        // Slots that are already grounded are carried into the next turn, so
        // a clarification exchange never has to ask for the same value twice.
        const resolved: Partial<Record<GroundingParam, string>> = {};
        for (const check of payload.trace.grounding.checks) {
          if (check.present && check.value) resolved[check.param] = check.value;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: makeId('a'),
            role: 'assistant',
            content: payload.trace.assistantMessage,
            ts: Date.now(),
            // Remember which slots the agent asked for. Layer 2 uses this to
            // scope chat-context grounding to this clarification exchange only.
            requests:
              payload.trace.action === 'CLARIFY_GROUNDING'
                ? payload.trace.grounding.missingParams
                : undefined,
            // ...and which slots were already resolved when it asked.
            resolved: payload.trace.action === 'CLARIFY_GROUNDING' ? resolved : undefined,
          },
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        setMessages((prev) => [
          ...prev,
          {
            id: makeId('e'),
            role: 'assistant',
            content: `I hit an internal error while routing that request (${message}). The guardrail log is unaffected — please try again.`,
            ts: Date.now(),
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, ingest],
  );

  /* ------------------------------------------------------------------ */
  /* Reset the session                                                  */
  /* ------------------------------------------------------------------ */
  const reset = useCallback(async () => {
    try {
      await fetch('/api/telemetry/reset', { method: 'POST' });
    } catch {
      /* the local reset below still applies */
    }
    seenEventIds.current.clear();
    setEvents([]);
    setTraces([]);
    setMessages([GREETING]);
    setError(null);
  }, []);

  /* ------------------------------------------------------------------ */
  /* Derived state                                                      */
  /* ------------------------------------------------------------------ */
  const live = useMemo(() => deriveLiveState(events), [events]);
  const metrics = useMemo(() => aggregateMetrics(traces), [traces]);

  return { messages, traces, events, live, metrics, connected, busy, error, send, reset };
}
