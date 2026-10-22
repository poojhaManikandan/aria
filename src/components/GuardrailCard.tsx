'use client';

import {
  AlertTriangle,
  Check,
  CircleSlash,
  Lock,
  ShieldCheck,
  ShieldX,
  Wrench,
  X,
} from 'lucide-react';
import type { ToolInvocation } from '@/lib/types';
import type { LiveState } from '@/lib/live-state';
import { cn, ms } from '@/lib/utils';

/**
 * Guardrail status light + tool-grounding checklist + tool execution state.
 * This is the "can the backend tool run?" answer, rendered for the judges.
 */

const STATUS = {
  GREEN: {
    label: 'TOOL GROUNDING APPROVED',
    title: 'Tool execution allowed',
    sub: 'All required parameters grounded · policy passed',
    ring: 'border-emerald-500/40',
    glow: 'shadow-glow-safe',
    text: 'text-emerald-300',
    bg: 'bg-emerald-500/10',
    dot: 'bg-emerald-400',
    Icon: ShieldCheck,
  },
  AMBER: {
    label: 'CLARIFICATION REQUIRED',
    title: 'Tool execution held',
    sub: 'Missing parameters · no write was attempted',
    ring: 'border-amber-500/40',
    glow: 'shadow-[0_0_0_1px_rgba(245,158,11,0.28),0_8px_40px_-12px_rgba(245,158,11,0.5)]',
    text: 'text-amber-300',
    bg: 'bg-amber-500/10',
    dot: 'bg-amber-400',
    Icon: AlertTriangle,
  },
  RED: {
    label: 'TOOL EXECUTION FROZEN',
    title: 'Request blocked at Layer 1',
    sub: 'Abuse signature detected · main LLM never invoked',
    ring: 'border-rose-500/45',
    glow: 'shadow-glow-fraud',
    text: 'text-rose-300',
    bg: 'bg-rose-500/10',
    dot: 'bg-rose-400',
    Icon: ShieldX,
  },
} as const;

interface GuardrailCardProps {
  live: LiveState;
  busy: boolean;
}

/** One grounded / missing parameter row. */
function GroundingRow({
  label,
  present,
  value,
  source,
}: {
  label: string;
  present: boolean;
  value?: string;
  source?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5',
        present
          ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
          : 'border-rose-500/25 bg-rose-500/[0.06]',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {present ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        ) : (
          <X className="h-3 w-3 shrink-0 text-rose-400" />
        )}
        <span className="text-[11px] text-slate-300">{label}</span>
      </span>
      <span
        className={cn(
          'truncate font-mono text-[10.5px]',
          present ? 'text-emerald-300' : 'text-rose-400',
        )}
        title={value}
      >
        {present ? value : 'MISSING'}
        {present && source === 'catalog' && (
          <span className="ml-1 text-[9px] text-slate-500">catalog</span>
        )}
        {present && source === 'chat_context' && (
          <span className="ml-1 text-[9px] text-slate-500">context</span>
        )}
      </span>
    </div>
  );
}

/** Tool execution receipt, including the frozen state. */
function ToolRow({ tool }: { tool: ToolInvocation }) {
  const frozen = tool.status === 'frozen';
  const skipped = tool.status === 'skipped';
  const executed = tool.status === 'executed';

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border px-2.5 py-2',
        frozen && 'border-rose-500/40 bg-rose-500/[0.08]',
        skipped && 'border-amber-500/30 bg-amber-500/[0.06]',
        executed && 'border-emerald-500/25 bg-emerald-500/[0.06]',
      )}
    >
      {frozen && (
        <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgba(244,63,94,0.07)_8px,rgba(244,63,94,0.07)_16px)]" />
      )}

      <div className="relative flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Wrench className={cn('h-3 w-3 shrink-0', frozen ? 'text-rose-400' : 'text-slate-500')} />
          <code
            className={cn(
              'truncate font-mono text-[11px]',
              frozen ? 'text-rose-200 line-through decoration-rose-500/60' : 'text-slate-200',
            )}
          >
            {tool.name}
          </code>
        </span>

        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider',
            frozen && 'border-rose-500/40 bg-rose-500/15 text-rose-300',
            skipped && 'border-amber-500/40 bg-amber-500/15 text-amber-300',
            executed && 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300',
          )}
        >
          {frozen && <Lock className="h-2.5 w-2.5" />}
          {tool.status}
        </span>
      </div>

      <div className="relative mt-1.5 space-y-0.5 font-mono text-[10px] text-slate-500">
        {Object.entries(tool.args).map(([key, value]) => (
          <div key={key} className="flex gap-1.5">
            <span className="text-slate-600">{key}:</span>
            <span className="truncate text-slate-400">{value === null ? 'null' : String(value)}</span>
          </div>
        ))}
        {tool.latencyMs > 0 && (
          <div className="flex gap-1.5">
            <span className="text-slate-600">latency:</span>
            <span className="text-slate-400">{ms(tool.latencyMs)}</span>
          </div>
        )}
        {tool.blockedReason && (
          <div className="mt-1 text-[10px] leading-snug text-rose-300/90">{tool.blockedReason}</div>
        )}
      </div>
    </div>
  );
}

export default function GuardrailCard({ live, busy }: GuardrailCardProps) {
  const status = STATUS[live.guardrail];
  const Icon = status.Icon;
  const hasTurn = Boolean(live.label);

  if (!hasTurn) {
    return (
      <div className="panel flex flex-col gap-3 p-3.5">
        <h3 className="panel-title">Guardrail status</h3>
        <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <span className="relative flex h-3 w-3">
            <span className="h-3 w-3 rounded-full bg-slate-700" />
          </span>
          <div>
            <p className="text-[12.5px] font-semibold text-slate-400">Standby</p>
            <p className="text-[11px] text-slate-600">
              Waiting for the first customer turn to classify.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'panel flex flex-col gap-3 p-3.5 transition-all duration-300',
        status.ring,
        status.glow,
        live.guardrail === 'RED' && 'animate-[flash-red_900ms_ease-out_1]',
      )}
    >
      <header className="flex items-center justify-between">
        <h3 className="panel-title">Guardrail status</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-slate-600">
          layer 2 · grounding
        </span>
      </header>

      {/* Traffic light */}
      <div className={cn('flex items-center gap-3 rounded-xl border p-3', status.ring, status.bg)}>
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
          <span className={cn('absolute h-9 w-9 rounded-full opacity-20', status.dot)} />
          {!live.complete && busy && (
            <span className={cn('absolute h-9 w-9 animate-pulse-ring rounded-full', status.dot)} />
          )}
          <span className={cn('relative flex h-9 w-9 items-center justify-center rounded-full', status.bg)}>
            <Icon className={cn('h-5 w-5', status.text)} />
          </span>
        </span>

        <div className="min-w-0">
          <p className={cn('font-mono text-[10.5px] font-bold uppercase tracking-[0.12em]', status.text)}>
            {status.label}
          </p>
          <p className="text-[13px] font-semibold text-slate-100">{status.title}</p>
          <p className="truncate text-[11px] text-slate-400">{status.sub}</p>
        </div>
      </div>

      {/* Grounding checklist (return requests only) */}
      {live.grounding && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-slate-500">
              required parameters
            </span>
            <span className="font-mono text-[9.5px] text-slate-600">
              {live.grounding.checks.filter((c) => c.present).length}/
              {live.grounding.checks.length} grounded
            </span>
          </div>
          {live.grounding.checks.map((check) => (
            <GroundingRow
              key={check.param}
              label={check.label}
              present={check.present}
              value={check.value}
              source={check.source}
            />
          ))}
        </div>
      )}

      {/* Tool execution state */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-slate-500">
            tool execution
          </span>
          {live.tools.length === 0 && (
            <span className="flex items-center gap-1 font-mono text-[9.5px] text-slate-600">
              <CircleSlash className="h-2.5 w-2.5" /> none requested
            </span>
          )}
        </div>

        {live.tools.length === 0 ? (
          <p className="rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2 text-[11px] text-slate-500">
            No tool call was requested for this turn.
          </p>
        ) : (
          live.tools.map((tool, index) => <ToolRow key={`${tool.name}-${index}`} tool={tool} />)
        )}
      </div>
    </div>
  );
}
