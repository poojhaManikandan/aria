'use client';

import { Activity, Fingerprint } from 'lucide-react';
import type { DecisionLabel } from '@/lib/types';
import { LABEL_STYLES } from '@/lib/constants';
import { rankedLabels, type LiveState } from '@/lib/live-state';
import { cn, pct } from '@/lib/utils';

/**
 * Confidence-score breakdown: the softmax distribution across the four
 * decision labels plus the pointers (attention) that produced it.
 */

interface ProbabilityChartProps {
  live: LiveState;
}

/** Circular confidence gauge. */
function ConfidenceRing({ value }: { value: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(1, Math.max(0, value)));

  return (
    <div className="relative h-[86px] w-[86px] shrink-0">
      <svg viewBox="0 0 86 86" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="confGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <circle cx="43" cy="43" r={radius} fill="none" stroke="#1e293b" strokeWidth="7" />
        <circle
          cx="43"
          cy="43"
          r={radius}
          fill="none"
          stroke="url(#confGradient)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-base font-bold tabular-nums text-slate-50">
          {(value * 100).toFixed(0)}
        </span>
        <span className="text-[8.5px] uppercase tracking-wider text-slate-500">conf</span>
      </div>
    </div>
  );
}

export default function ProbabilityChart({ live }: ProbabilityChartProps) {
  const ranked = rankedLabels(live.probabilities);
  const winner: DecisionLabel | null = live.label;

  return (
    <div className="panel p-3.5">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="panel-title">Confidence breakdown</h3>
        <span className="flex items-center gap-1 font-mono text-[10px] text-slate-600">
          <Activity className="h-3 w-3" />
          softmax · T=1.0
        </span>
      </header>

      <div className="flex gap-4">
        <div className="min-w-0 flex-1 space-y-2.5">
          {ranked.map(({ label, probability }) => {
            const styles = LABEL_STYLES[label];
            const isWinner = label === winner;
            const width = Math.max(probability * 100, probability > 0 ? 1.5 : 0.6);

            return (
              <div key={label} className="group">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'truncate font-mono text-[10.5px] transition-colors',
                      isWinner ? styles.text : 'text-slate-500',
                      isWinner && 'font-semibold',
                    )}
                  >
                    {label}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-[10.5px] tabular-nums',
                      isWinner ? styles.text : 'text-slate-600',
                    )}
                  >
                    {pct(probability, 1)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/70 ring-1 ring-inset ring-slate-900">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-700 ease-out',
                      styles.bar,
                      isWinner ? 'opacity-100' : 'opacity-40',
                    )}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col items-center justify-center gap-2 border-l border-slate-800/70 pl-4">
          <ConfidenceRing value={live.confidence} />
          <span className="text-center text-[9.5px] leading-tight text-slate-600">
            calibrated
            <br />
            confidence
          </span>
        </div>
      </div>

      {/* Pointers that fired — the "attention" of the 2B head. */}
      <div className="mt-3 border-t border-slate-800/60 pt-2.5">
        <div className="mb-2 flex items-center gap-1.5">
          <Fingerprint className="h-3 w-3 text-slate-500" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Pointers fired
          </span>
        </div>

        {live.attributions.length === 0 ? (
          <p className="text-[11px] text-slate-600">No pointers yet — send a message to classify.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {live.attributions.map((attribution, index) => (
              <span
                key={`${attribution.feature}-${index}`}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px]',
                  LABEL_STYLES[attribution.label].border,
                  LABEL_STYLES[attribution.label].bg,
                  LABEL_STYLES[attribution.label].text,
                )}
                title={`Matched: "${attribution.trigger}"`}
              >
                <span className="font-mono">{attribution.feature}</span>
                <span className="font-mono text-[9.5px] opacity-70">
                  {attribution.weight > 0 ? '+' : ''}
                  {attribution.weight.toFixed(1)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
