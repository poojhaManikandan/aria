'use client';

import { SCENARIOS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { FlaskConical, ShieldAlert, Sparkles, TriangleAlert } from 'lucide-react';

/**
 * One-click judge scenarios.
 * Each button pre-fills the composer with a canned customer utterance and
 * (via the parent) sends it straight into the pipeline.
 */

const TONE_STYLES = {
  safe: {
    ring: 'hover:border-emerald-500/60 hover:bg-emerald-500/10',
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    icon: 'text-emerald-400',
  },
  fraud: {
    ring: 'hover:border-rose-500/60 hover:bg-rose-500/10',
    badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    icon: 'text-rose-400',
  },
  ground: {
    ring: 'hover:border-amber-500/60 hover:bg-amber-500/10',
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    icon: 'text-amber-400',
  },
} as const;

const ICONS = {
  safe: Sparkles,
  fraud: ShieldAlert,
  ground: TriangleAlert,
} as const;

interface ScenarioBarProps {
  onSelect: (message: string) => void;
  disabled?: boolean;
}

export default function ScenarioBar({ onSelect, disabled }: ScenarioBarProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <FlaskConical className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Judge scenarios
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {SCENARIOS.map((scenario) => {
          const Icon = ICONS[scenario.tone];
          const styles = TONE_STYLES[scenario.tone];

          return (
            <button
              key={scenario.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(scenario.message)}
              className={cn(
                'group flex flex-col gap-1.5 rounded-xl border border-slate-800 bg-slate-900/50 p-2.5 text-left',
                'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-panel disabled:opacity-40',
                styles.ring,
              )}
              title={scenario.expected}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-md border text-[10px] font-bold',
                    styles.badge,
                  )}
                >
                  {scenario.key}
                </span>
                <Icon className={cn('h-3.5 w-3.5', styles.icon)} />
                <span className="truncate text-[12px] font-semibold text-slate-200">
                  {scenario.title}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-slate-500">{scenario.subtitle}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
