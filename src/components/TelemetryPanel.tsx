'use client';

import { Activity, Layers, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import type { SessionMetrics, TelemetryEvent } from '@/lib/types';
import type { LiveState } from '@/lib/live-state';
import { cn, int, ms, pct } from '@/lib/utils';
import EventStream from './EventStream';
import GuardrailCard from './GuardrailCard';
import MetricCards from './MetricCards';
import PipelineRail from './PipelineRail';
import ProbabilityChart from './ProbabilityChart';

/**
 * Right-hand telemetry column.
 *
 * Layout note: the decision-engine log is pinned to the bottom of the panel
 * (never inside the scroll area) so it stays visible during a live demo while
 * the analysis cards above scroll independently.
 */

interface TelemetryPanelProps {
  live: LiveState;
  metrics: SessionMetrics;
  events: TelemetryEvent[];
  connected: boolean;
  busy: boolean;
  onReset: () => void;
}

function SessionStat({ label, value }: { label: string; value: string }) {
  // The unit is rendered at (almost) the same size as the number. Dimming it
  // to 10px made "ms" read as "ns" in screenshots, which is nonsense for a
  // model that takes hundreds of milliseconds.
  const match = /^([\d.,]+)\s*(ms|s)$/.exec(value);

  return (
    <div className="flex min-w-0 flex-col">
      <span className="whitespace-nowrap font-mono text-[13px] font-semibold tabular-nums text-slate-100">
        {match ? (
          <>
            {match[1]}
            <span className="ml-1 text-[12px] font-semibold tracking-normal text-slate-400">
              {match[2]}
            </span>
          </>
        ) : (
          value
        )}
      </span>
      <span className="text-[9.5px] uppercase tracking-[0.12em] text-slate-600">{label}</span>
    </div>
  );
}

export default function TelemetryPanel({
  live,
  metrics,
  events,
  connected,
  busy,
  onReset,
}: TelemetryPanelProps) {
  const totalLatency = live.deciderLatencyMs + live.mainAgentLatencyMs;

  return (
    <section className="panel flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header className="shrink-0 border-b border-slate-800/70 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-sky-500/30 bg-sky-500/10">
                <Layers className="h-3.5 w-3.5 text-sky-300" />
              </span>
              <h2 className="text-sm font-semibold text-slate-100">AI Decision Engine</h2>
              <span
                className={cn(
                  'chip',
                  connected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-rose-500/30 bg-rose-500/10 text-rose-300',
                )}
              >
                {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {connected ? 'live' : 'offline'}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-slate-500">
              Real-time telemetry · Strands Decider 2B vs. Bedrock Claude 3.5 Sonnet
            </p>
          </div>

          <button
            type="button"
            onClick={onReset}
            className="btn-ghost h-8 shrink-0 px-2.5 py-0 text-[11px]"
            title="Clear the session telemetry"
          >
            <RefreshCw className="h-3 w-3" />
            Reset
          </button>
        </div>

        {/* Session strip */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-slate-800/80 bg-slate-950/40 px-3 py-2 sm:grid-cols-6">
          <SessionStat label="User turns" value={int(metrics.turns)} />
          <SessionStat label="Agent runs" value={int(metrics.agentInvocations)} />
          <SessionStat label="Blocked" value={int(metrics.blocked)} />
          <SessionStat
            label="Decider avg"
            value={metrics.turns ? ms(metrics.deciderLatencyMsAvg) : '—'}
          />
          <SessionStat
            label="Agent avg"
            value={metrics.mainAgentLatencyMsAvg ? ms(metrics.mainAgentLatencyMsAvg) : '—'}
          />
          <SessionStat label="Saved" value={pct(metrics.costSavedPct, 0)} />
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Scrollable analysis                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <MetricCards live={live} metrics={metrics} />
        <PipelineRail live={live} busy={busy} />
        <ProbabilityChart live={live} />
        <GuardrailCard live={live} busy={busy} />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Pinned live log                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="shrink-0 border-t border-slate-800/70 bg-slate-950/40 px-3 pb-3 pt-2">
        <div className="mb-1.5 flex items-center justify-between px-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-slate-600">
          <span className="flex items-center gap-1.5">
            <Activity className="h-3 w-3" />
            end-to-end
          </span>
          <span className="text-slate-400">{totalLatency > 0 ? ms(totalLatency) : '—'}</span>
          <span className="hidden text-right sm:block">
            decider {live.deciderLatencyMs ? ms(live.deciderLatencyMs) : '0ms'} · agent{' '}
            {live.mainAgentLatencyMs ? ms(live.mainAgentLatencyMs) : 'not invoked'}
          </span>
        </div>
        <EventStream events={events} connected={connected} />
      </div>
    </section>
  );
}
