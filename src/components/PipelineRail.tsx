'use client';

import { Bot, Check, Cpu, Link2, Lock, Minus, X } from 'lucide-react';
import type { LiveState } from '@/lib/live-state';
import { cn, ms } from '@/lib/utils';

/**
 * Visual representation of the three-layer execution path.
 * Each node lights up as the pipeline moves through it.
 */

type NodeState = 'idle' | 'active' | 'done' | 'blocked' | 'held' | 'skipped';

const NODE_STYLES: Record<NodeState, { ring: string; icon: string; dot: string; label: string }> = {
  idle: {
    ring: 'border-slate-800 bg-slate-900/40',
    icon: 'text-slate-600',
    dot: 'bg-slate-700',
    label: 'text-slate-600',
  },
  active: {
    ring: 'border-sky-500/60 bg-sky-500/10 shadow-glow',
    icon: 'text-sky-300',
    dot: 'bg-sky-400 animate-pulse',
    label: 'text-sky-300',
  },
  done: {
    ring: 'border-emerald-500/50 bg-emerald-500/10',
    icon: 'text-emerald-300',
    dot: 'bg-emerald-400',
    label: 'text-emerald-300',
  },
  blocked: {
    ring: 'border-rose-500/60 bg-rose-500/10 shadow-glow-fraud',
    icon: 'text-rose-300',
    dot: 'bg-rose-400',
    label: 'text-rose-300',
  },
  held: {
    ring: 'border-amber-500/50 bg-amber-500/10',
    icon: 'text-amber-300',
    dot: 'bg-amber-400',
    label: 'text-amber-300',
  },
  skipped: {
    ring: 'border-slate-800/70 bg-slate-900/20 opacity-60',
    icon: 'text-slate-700',
    dot: 'bg-slate-800',
    label: 'text-slate-700',
  },
};

/** Human-readable names for the tool parameters the grounding layer demands. */
const PARAM_COPY: Record<string, string> = {
  ORDER_ID: 'Order ID',
  ITEM_SKU: 'Item SKU',
  REASON: 'Reason',
};

interface PipelineRailProps {
  live: LiveState;
  busy: boolean;}

export default function PipelineRail({ live, busy }: PipelineRailProps) {
  /* --------------------------- Layer 1 --------------------------- */
  let l1: NodeState = 'idle';
  if (live.blocked) l1 = 'blocked';
  else if (live.label) l1 = 'done';
  else if (busy && live.stage === 'DECIDER_START') l1 = 'active';

  /* --------------------------- Layer 2 --------------------------- */
  let l2: NodeState = 'skipped';
  if (live.grounding) l2 = live.grounding.approved ? 'done' : 'held';
  else if (live.blocked) l2 = 'skipped';
  else if (busy && live.stage === 'GROUNDING_CHECK') l2 = 'active';

  /* --------------------------- Layer 3 --------------------------- */
  let l3: NodeState = 'skipped';
  if (live.mainAgentInvoked) l3 = live.complete ? 'done' : 'active';
  else if (live.blocked) l3 = 'skipped';

  const nodes = [
    {
      key: 'l1',
      index: '01',
      title: 'Policy Classifier',
      subtitle: 'Strands Decider 2B',
      icon: Cpu,
      state: l1,
      detail: live.label
        ? `${live.label.replace(/_/g, ' ').toLowerCase()} · ${(live.confidence * 100).toFixed(1)}%`
        : busy
          ? 'classifying…'
          : 'standby',
    },
    {
      key: 'l2',
      index: '02',
      title: 'Parameter Grounding',
      subtitle: 'Order ID · SKU · Reason',
      icon: Link2,
      state: l2,
      detail: live.grounding
        ? live.grounding.approved
          ? 'all parameters grounded'
          : `missing ${live.grounding.missing.map((p) => PARAM_COPY[p] ?? p).join(', ')}`
        : 'not required',
    },
    {
      key: 'l3',
      index: '03',
      title: 'Main Agent',
      subtitle: 'Bedrock Claude 3.5 Sonnet',
      icon: Bot,
      state: l3,
      detail: live.mainAgentInvoked
        ? live.mainAgentLatencyMs
          ? ms(live.mainAgentLatencyMs)
          : 'running'
        : live.blocked
          ? 'never invoked'
          : 'standby',
    },
  ];

  return (
    <div className="panel p-3.5">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="panel-title">Execution path</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
          layer 1 → 2 → 3
        </span>
      </header>

      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-1.5">
        {nodes.map((node, index) => {
          const styles = NODE_STYLES[node.state];
          const Icon = node.icon;

          return (
            <div key={node.key} className="contents">
              <div
                className={cn(
                  'relative flex flex-col gap-1.5 rounded-xl border p-2.5 transition-all duration-300',
                  styles.ring,
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cn('font-mono text-[10px] font-semibold', styles.label)}>
                    L{node.index}
                  </span>
                  <span className={cn('h-1.5 w-1.5 rounded-full', styles.dot)} />
                </div>

                <div className="flex items-center gap-1.5">
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', styles.icon)} />
                  <span className="truncate text-[11.5px] font-semibold text-slate-200">
                    {node.title}
                  </span>
                </div>

                <p className="truncate font-mono text-[9.5px] text-slate-500">{node.subtitle}</p>
                <p className={cn('truncate text-[10px]', styles.label)}>{node.detail}</p>

                {node.state === 'blocked' && (
                  <Lock className="absolute right-2 top-2 h-3 w-3 text-rose-400" />
                )}
              </div>

              {index < nodes.length - 1 && (
                <div className="flex items-center">
                  <div
                    className={cn(
                      'h-px w-3 transition-colors duration-300',
                      node.state === 'done' ? 'bg-emerald-500/60' : 'bg-slate-800',
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800/60 pt-2.5 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <Check className="h-3 w-3 text-emerald-400" /> completed
        </span>
        <span className="flex items-center gap-1">
          <Cpu className="h-3 w-3 text-sky-400" /> in flight
        </span>
        <span className="flex items-center gap-1">
          <X className="h-3 w-3 text-rose-400" /> blocked
        </span>
        <span className="flex items-center gap-1">
          <Minus className="h-3 w-3 text-slate-600" /> skipped
        </span>
      </div>
    </div>
  );
}
