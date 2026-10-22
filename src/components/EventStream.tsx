'use client';

import { useEffect, useRef } from 'react';
import {
  Activity,
  Gauge,
  Lock,
  Radio,
  Shield,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { TelemetryEvent, TelemetryKind, TelemetryLayer } from '@/lib/types';
import { clock, cn } from '@/lib/utils';

/**
 * Live decision-engine event log (streamed over SSE).
 */

const LAYER_BADGE: Record<TelemetryLayer, { text: string; className: string }> = {
  0: { text: 'SYS', className: 'border-slate-700 bg-slate-800/70 text-slate-400' },
  1: { text: 'L1', className: 'border-sky-500/40 bg-sky-500/15 text-sky-300' },
  2: { text: 'L2', className: 'border-amber-500/40 bg-amber-500/15 text-amber-300' },
  3: { text: 'L3', className: 'border-violet-500/40 bg-violet-500/15 text-violet-300' },
};

const KIND_ICON: Record<TelemetryKind, typeof Activity> = {
  log: Terminal,
  metric: Activity,
  decision: Gauge,
  guard: Shield,
  tool: Wrench,
  freeze: Lock,
  latency: Gauge,
};

const LEVEL_TEXT = {
  info: 'text-slate-300',
  success: 'text-emerald-200',
  warn: 'text-amber-200',
  error: 'text-rose-200',
} as const;

interface EventStreamProps {
  events: TelemetryEvent[];
  connected: boolean;
}

export default function EventStream({ events, connected }: EventStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Auto-follow new events unless the user has scrolled up to inspect.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedRef.current = distance < 48;
  };

  return (
    <div className="panel flex min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-slate-800/70 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-slate-500" />
          <h3 className="panel-title">Decision engine log</h3>
          <span className="font-mono text-[10px] text-slate-600">{events.length}</span>
        </div>
        <span
          className={cn(
            'flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wider',
            connected ? 'text-emerald-400' : 'text-rose-400',
          )}
        >
          <Radio className={cn('h-3 w-3', connected && 'animate-pulse')} />
          {connected ? 'sse live' : 'reconnecting'}
        </span>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Live decision engine events"
        className="scroll-thin grid-fade h-[190px] min-h-0 overflow-y-auto px-2 py-2"
      >
        {events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <Activity className="h-4 w-4 text-slate-700" />
            <p className="text-[11px] text-slate-600">
              No events yet — run a scenario to stream the pipeline.
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {events.map((event) => {
              const layer = LAYER_BADGE[event.layer];
              const Icon = KIND_ICON[event.kind];

              return (
                <li
                  key={event.id}
                  className={cn(
                    'group flex items-start gap-2 rounded-md px-1.5 py-1 font-mono text-[10.5px] leading-relaxed transition-colors hover:bg-slate-800/40',
                    event.level === 'error' && 'bg-rose-500/[0.07]',
                    event.kind === 'freeze' && 'bg-rose-500/[0.05]',
                  )}
                >
                  <span className="shrink-0 pt-px text-slate-600">{clock(event.ts)}</span>

                  <span
                    className={cn(
                      'mt-px shrink-0 rounded border px-1 text-[8.5px] font-bold leading-[14px]',
                      layer.className,
                    )}
                  >
                    {layer.text}
                  </span>

                  <Icon
                    className={cn(
                      'mt-[3px] h-2.5 w-2.5 shrink-0',
                      event.level === 'error'
                        ? 'text-rose-400'
                        : event.level === 'warn'
                          ? 'text-amber-400'
                          : event.level === 'success'
                            ? 'text-emerald-400'
                            : 'text-slate-600',
                    )}
                  />

                  <span className="min-w-0 flex-1">
                    <span className={cn('font-semibold', LEVEL_TEXT[event.level])}>{event.title}</span>
                    <span className="text-slate-600"> · </span>
                    <span className="break-words text-slate-500">{event.message}</span>
                  </span>

                  {typeof event.durationMs === 'number' && event.durationMs > 0 && (
                    <span className="shrink-0 pt-px text-slate-600">{Math.round(event.durationMs)}ms</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
