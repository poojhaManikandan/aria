'use client';

import { Ban, Gauge, PiggyBank, ShieldAlert, Sparkles, Timer, TrendingDown, Zap } from 'lucide-react';
import type { SessionMetrics } from '@/lib/types';
import type { LiveState } from '@/lib/live-state';
import { MODEL_COST } from '@/lib/constants';
import { cn, int, ms, pct, usd } from '@/lib/utils';

/**
 * Headline telemetry cards — the live Decider-2B vs. Main-LLM comparison.
 */

interface ComparisonRowProps {
  label: string;
  value: string;
  ratio: number;
  barClass: string;
  caption: string;
}

/** One row of the side-by-side latency / cost comparison. */
function ComparisonRow({ label, value, ratio, barClass, caption }: ComparisonRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          {caption}
        </span>
        <span className="font-mono text-[12px] font-semibold tabular-nums text-slate-100">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/80">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', barClass)}
          style={{ width: `${Math.max(3, Math.min(100, ratio * 100))}%` }}
        />
      </div>
      <span className="text-[10px] uppercase tracking-wider text-slate-600">{label}</span>
    </div>
  );
}

interface MetricCardsProps {
  live: LiveState;
  metrics: SessionMetrics;
}

export default function MetricCards({ live, metrics }: MetricCardsProps) {
  const deciderMs = live.deciderLatencyMs;
  const mainMs = live.mainAgentLatencyMs;
  const maxLatency = Math.max(deciderMs, mainMs, 1);

  const speedup = mainMs > 0 ? mainMs / Math.max(1, deciderMs) : 0;
  const costRatio = MODEL_COST.MAIN_AGENT_USD / MODEL_COST.DECIDER_USD;

  /**
   * "Cost avoided" has to mean something to a judge. Two kinds of money are
   * avoided on a blocked turn: the LLM spend that never happened, and the
   * order value that was never refunded. When a fraud attempt is stopped the
   * headline becomes the attack value — that is the number that matters.
   */
  const attackValueAvoided = live.preventedExposureUsd;
  const turnValueAvoided = attackValueAvoided + live.costSavedUsd;
  const turnHeadline =
    attackValueAvoided > 0 ? `$${int(attackValueAvoided)}` : usd(live.costSavedUsd);
  const turnCaption =
    attackValueAvoided > 0
      ? 'attack value prevented this turn — no refund was issued'
      : live.costSavedUsd > 0
        ? `API spend avoided this turn · ${pct(live.costSavedUsd / MODEL_COST.MAIN_AGENT_USD, 0)} of the $0.03 baseline`
        : live.mainAgentInvoked
          ? 'the full agent ran — latency saved, not dollars'
          : 'no agent spend avoided this turn';

  const cards = [
    {
      key: 'latency',
      icon: Gauge,
      title: 'Latency',
      accent: 'text-sky-300',
      iconBg: 'bg-sky-500/10 border-sky-500/30',
      body: (
        <>
          <ComparisonRow
            label="Strands Decider 2B"
            value={deciderMs ? ms(deciderMs) : '—'}
            ratio={deciderMs / maxLatency}
            barClass="bg-gradient-to-r from-sky-400 to-cyan-300"
            caption="Decider 2B gate"
          />
          <ComparisonRow
            label="Bedrock Claude 3.5 Sonnet"
            value={mainMs ? ms(mainMs) : 'not invoked'}
            ratio={mainMs / maxLatency}
            barClass="bg-gradient-to-r from-violet-400 to-fuchsia-400"
            caption="Main agent turn"
          />
        </>
      ),
      footer: speedup > 0 ? (
        <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          <Zap className="h-3 w-3" />
          {speedup.toFixed(0)}× faster gate
        </span>
      ) : (
        <span className="chip border-slate-700/70 bg-slate-800/40 text-slate-500">awaiting turn</span>
      ),
    },
    {
      key: 'cost',
      icon: PiggyBank,
      title: 'Cost per execution',
      accent: 'text-violet-300',
      iconBg: 'bg-violet-500/10 border-violet-500/30',
      body: (
        <>
          <ComparisonRow
            label="Strands Decider 2B"
            value={usd(MODEL_COST.DECIDER_USD)}
            ratio={MODEL_COST.DECIDER_USD / MODEL_COST.MAIN_AGENT_USD}
            barClass="bg-gradient-to-r from-sky-400 to-cyan-300"
            caption="Decider 2B gate"
          />
          <ComparisonRow
            label="Bedrock Claude 3.5 Sonnet"
            value={usd(MODEL_COST.MAIN_AGENT_USD)}
            ratio={1}
            barClass="bg-gradient-to-r from-violet-400 to-fuchsia-400"
            caption="Main agent turn"
          />
        </>
      ),
      footer: (
        <span className="chip border-violet-500/30 bg-violet-500/10 text-violet-300">
          <TrendingDown className="h-3 w-3" />
          {costRatio.toFixed(0)}× cheaper per call
        </span>
      ),
    },
    {
      key: 'saved',
      icon: Sparkles,
      title: 'Cost avoided',
      accent: 'text-emerald-300',
      iconBg: 'bg-emerald-500/10 border-emerald-500/30',
      body: (
        <div className="space-y-2">
          <div>
            <div
              key={live.traceId ?? 'idle'}
              className={cn(
                'stat-value',
                turnValueAvoided > 0 ? 'animate-money-pop text-emerald-300' : 'text-slate-500',
              )}
            >
              {turnHeadline}
            </div>
            <p className="text-[11px] text-slate-500">{turnCaption}</p>
            {live.preventedExposureUsd > 0 && (
              <p className="mt-1 animate-money-pop text-[11px] font-semibold text-emerald-300">
                + {usd(live.costSavedUsd)} of Sonnet spend avoided — the main LLM was never called
              </p>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/80">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-300 transition-[width] duration-700"
              style={{ width: `${Math.min(100, (live.costSavedUsd / MODEL_COST.MAIN_AGENT_USD) * 100)}%` }}
            />
          </div>
          <div className="space-y-1 border-t border-slate-800/60 pt-2">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-slate-500">Session · API spend</span>
              <span
                className={cn(
                  'whitespace-nowrap font-mono font-semibold tabular-nums',
                  metrics.costSavedUsd > 0 ? 'text-emerald-300' : 'text-slate-600',
                )}
              >
                {usd(metrics.costSavedUsd)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-slate-500">Session · fraud blocked</span>
              <span
                className={cn(
                  'whitespace-nowrap font-mono font-semibold tabular-nums',
                  metrics.preventedExposureUsd > 0 ? 'text-emerald-300' : 'text-slate-600',
                )}
              >
                ${int(metrics.preventedExposureUsd)}
              </span>
            </div>
            {metrics.costSavedUsd > 0 && (
              <div className="flex items-baseline justify-between gap-2 text-[10.5px] text-slate-600">
                <span>Extrapolated</span>
                <span className="whitespace-nowrap">≈ ${(metrics.costSavedUsd * 1000).toFixed(2)} / 1k turns</span>
              </div>
            )}
          </div>
        </div>
      ),
      footer: (
        <span className="chip border-slate-700/70 bg-slate-800/40 text-slate-400">
          {metrics.turns} turn{metrics.turns === 1 ? '' : 's'} measured
        </span>
      ),
    },
    {
      key: 'exposure',
      icon: ShieldAlert,
      title: 'Fraud exposure',
      accent: 'text-rose-300',
      iconBg: 'bg-rose-500/10 border-rose-500/30',
      body: (
        <div className="space-y-2">
          <div>
            <div
              key={live.traceId ?? 'idle'}
              className={cn(
                'stat-value',
                metrics.preventedExposureUsd > 0
                  ? 'animate-money-pop text-rose-300'
                  : 'text-slate-500',
              )}
            >
              {metrics.preventedExposureUsd > 0 ? `$${int(metrics.preventedExposureUsd)}` : '$0'}
            </div>
            <p className="text-[11px] text-slate-500">order value protected across the session</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="chip border-rose-500/30 bg-rose-500/10 text-rose-300">
              <Ban className="h-3 w-3" />
              {metrics.blocked} blocked
            </span>
            <span className="chip border-slate-700/70 bg-slate-800/40 text-slate-400">
              <Timer className="h-3 w-3" />
              {metrics.frozenToolCalls} frozen
            </span>
          </div>
        </div>
      ),
      footer: (
        <span className="chip border-slate-700/70 bg-slate-800/40 text-slate-400">
          {metrics.toolCalls} tool call{metrics.toolCalls === 1 ? '' : 's'} executed
        </span>
      ),
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <article key={card.key} className="panel flex flex-col gap-3 p-3.5">
            <header className="flex items-center gap-2">
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-md border', card.iconBg)}>
                <Icon className={cn('h-3.5 w-3.5', card.accent)} />
              </span>
              <h3 className="panel-title">{card.title}</h3>
            </header>

            <div className="flex-1 space-y-3">{card.body}</div>

            <footer>{card.footer}</footer>
          </article>
        );
      })}
    </div>
  );
}
