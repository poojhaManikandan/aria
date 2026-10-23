'use client';

import { useState } from 'react';
import {
  Activity,
  Cpu,
  Github,
  LayoutDashboard,
  MessageSquare,
  Radio,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useAgentConsole } from '@/lib/useAgentConsole';
import { REPO_SLUG, REPO_URL } from '@/lib/constants';
import { cn } from '@/lib/utils';
import ChatPanel from './ChatPanel';
import TelemetryPanel from './TelemetryPanel';

/**
 * Top-level console: persistent header + responsive split screen.
 *
 * Desktop: chat (left) and telemetry (right) side by side.
 * Mobile:  a tab bar switches between the two panes.
 */
export default function AgentConsole() {
  const { messages, events, live, metrics, connected, busy, error, send, startScenario, reset } =
    useAgentConsole();
  const [mobileTab, setMobileTab] = useState<'chat' | 'telemetry'>('chat');

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header className="z-20 shrink-0 border-b border-slate-800/70 bg-slate-950/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1800px] items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 via-sky-500 to-indigo-600 shadow-glow">
              <ShieldCheck className="h-5 w-5 text-slate-950" />
              <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-slate-950 bg-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-950" />
              </span>
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-bold tracking-tight text-slate-50">
                  Autonomous E-Commerce Support
                  <span className="text-slate-500"> & </span>
                  Fraud-Guard Agent
                </h1>
                <span className="hidden shrink-0 items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300 sm:inline-flex">
                  <Sparkles className="h-2.5 w-2.5" />
                  Agent Experience Hackathon
                </span>
              </div>
              <p className="truncate text-[11px] text-slate-500">
                Deterministic pre-flight gatekeeper · 4-class policy classifier · tool-grounding guardrail
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {REPO_SLUG ? (
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                title={`View the source code on GitHub — ${REPO_SLUG}`}
                className="chip border-slate-700/70 bg-slate-800/40 text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-800/80 hover:text-white"
              >
                <Github className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Source</span>
                <span className="hidden max-w-[13rem] truncate font-mono text-[10px] text-slate-500 lg:inline">
                  {REPO_SLUG}
                </span>
              </a>
            ) : (
              <span
                title="Set NEXT_PUBLIC_REPO_URL to link the public repository (see .env.example)"
                className="chip border-slate-800/80 bg-slate-900/40 text-slate-600"
              >
                <Github className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Source</span>
              </span>
            )}

            <div className="hidden items-center gap-2 md:flex">
              <span className="chip border-sky-500/30 bg-sky-500/10 text-sky-300">
                <Cpu className="h-3 w-3" />
                Strands Decider 2B
              </span>
              <span className="chip border-violet-500/30 bg-violet-500/10 text-violet-300">
                <Activity className="h-3 w-3" />
                Bedrock Claude 3.5 Sonnet
              </span>
              <span
                className={cn(
                  'chip',
                  connected
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700/70 bg-slate-800/40 text-slate-500',
                )}
              >
                <Radio className={cn('h-3 w-3', connected && 'animate-pulse')} />
                {connected ? 'Telemetry live' : 'Connecting'}
              </span>
            </div>
          </div>
        </div>

        {/* Mobile pane switcher */}
        <div className="flex border-t border-slate-800/70 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileTab('chat')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-semibold transition-colors',
              mobileTab === 'chat'
                ? 'border-b-2 border-sky-400 bg-sky-500/5 text-sky-300'
                : 'text-slate-500',
            )}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Support chat
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('telemetry')}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-semibold transition-colors',
              mobileTab === 'telemetry'
                ? 'border-b-2 border-sky-400 bg-sky-500/5 text-sky-300'
                : 'text-slate-500',
            )}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            Decision engine
            {metrics.blocked > 0 && (
              <span className="rounded-full bg-rose-500/20 px-1.5 text-[10px] text-rose-300">
                {metrics.blocked}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Split screen                                                     */}
      {/* ---------------------------------------------------------------- */}
      <main className="mx-auto min-h-0 w-full max-w-[1800px] flex-1 p-3 sm:p-4">
        <div className="grid h-full min-h-0 gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className={cn('min-h-0', mobileTab === 'chat' ? 'block' : 'hidden lg:block')}>
            <ChatPanel
              messages={messages}
              busy={busy}
              live={live}
              error={error}
              onSend={send}
              onScenario={startScenario}
            />
          </div>

          <div className={cn('min-h-0', mobileTab === 'telemetry' ? 'block' : 'hidden lg:block')}>
            <TelemetryPanel
              live={live}
              metrics={metrics}
              events={events}
              connected={connected}
              busy={busy}
              onReset={reset}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
