'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, CornerDownLeft, Cpu, Loader2, Send, ShieldCheck, Sparkles, User } from 'lucide-react';
import type { ChatMessage } from '@/lib/types';
import type { LiveState } from '@/lib/live-state';
import { cn } from '@/lib/utils';
import MiniMarkdown from './MiniMarkdown';
import ScenarioBar from './ScenarioBar';

/**
 * Customer-facing chat widget (left half of the split screen).
 */

interface ChatPanelProps {
  messages: ChatMessage[];
  busy: boolean;
  live: LiveState;
  error: string | null;
  onSend: (text: string) => void;
  onScenario: (text: string) => void | Promise<void>;
}

/** Human-readable copy for the live pipeline stage. */
const STAGE_COPY: Record<string, string> = {
  IDLE: 'Standing by',
  TURN_RECEIVED: 'Receiving turn',
  DECIDER_START: 'Layer 1 · running policy classification',
  DECIDER_RESULT: 'Layer 1 · classification complete',
  LOW_CONFIDENCE: 'Layer 1 · low confidence — failing safe',
  PARAMETERS_EXTRACTED: 'Layer 2 · extracting tool parameters',
  PARAMETERS_VALIDATED: 'Layer 2 · validating tool parameters',
  GROUNDING_CHECK: 'Layer 2 · grounding tool parameters',
  CLARIFICATION_REPLY: 'Layer 1 · recognising your answer',
  CLARIFICATION_RESET: 'Layer 1 · starting a fresh refund request',
  CLARIFICATION_LIMIT: 'Layer 2 · clarification limit reached',
  AWAITING_CLARIFICATION: 'Layer 2 · waiting for missing details',
  READY_TO_EXECUTE: 'Layer 2 · approved — handing off to Layer 3',
  TOOL_HELD: 'Layer 2 · holding tool back',
  TOOL_FROZEN: 'Layer 1 · freezing tool execution',
  GUARDRAIL_BLOCK: 'Layer 1 · intercepting request',
  AGENT_INVOKE: 'Layer 3 · invoking Bedrock Claude 3.5 Sonnet',
  AGENT_THINK: 'Layer 3 · planning',
  POLICY_CHECK: 'Layer 3 · applying refund policy',
  TOOL_CALL: 'Layer 3 · calling tool',
  AGENT_COMPLETE: 'Layer 3 · composing answer',
  TURN_COMPLETE: 'Turn complete',
};

export default function ChatPanel({
  messages,
  busy,
  live,
  error,
  onSend,
  onScenario,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const submit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
    setInput('');
    onSend(text);
  };

  /**
   * Scenario buttons start a clean test conversation and submit exactly once.
   * There is deliberately no timer: a timer allowed two rapid clicks to queue
   * two sends before React re-rendered the disabled state.
   */
  const runScenario = (message: string) => {
    if (busy) return;
    setInput('');
    void onScenario(message);
  };

  const stageCopy = STAGE_COPY[live.stage] ?? live.stage;

  return (
    <section className="panel flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header className="flex items-center justify-between gap-3 border-b border-slate-800/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-600 shadow-glow">
              <Bot className="h-5 w-5 text-slate-950" />
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-900 bg-emerald-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-slate-100">Aria</h2>
              <span className="chip border-sky-500/30 bg-sky-500/10 text-sky-300">
                <ShieldCheck className="h-3 w-3" />
                Layer-1 gated
              </span>
            </div>
            <p className="truncate text-[11px] text-slate-500">
              Autonomous e-commerce support · every turn classified before the LLM
            </p>
          </div>
        </div>

        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <span className="chip border-slate-700/70 bg-slate-800/40 text-slate-400">
            <Cpu className="h-3 w-3" />
            {live.label ? live.label.replace(/_/g, ' ').toLowerCase() : 'idle'}
          </span>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Transcript                                                       */}
      {/* ---------------------------------------------------------------- */}
      <div
        ref={scrollRef}
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Support conversation"
        className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
      >
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="flex animate-fade-up justify-end gap-2.5">
              <div className="max-w-[82%] rounded-2xl rounded-br-md border border-slate-700/60 bg-slate-800/70 px-3.5 py-2.5 shadow-panel">
                <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-slate-100">
                  {message.content}
                </p>
              </div>
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/80">
                <User className="h-3.5 w-3.5 text-slate-400" />
              </div>
            </div>
          ) : (
            <div key={message.id} className="flex animate-fade-up gap-2.5">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
                <Sparkles className="h-3.5 w-3.5 text-sky-300" />
              </div>
              <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-slate-800/90 bg-slate-900/70 px-3.5 py-2.5 shadow-panel">
                <MiniMarkdown content={message.content} />
              </div>
            </div>
          ),
        )}

        {/* Live pipeline indicator while the turn is in flight. */}
        {busy && (
          <div className="flex animate-fade-in gap-2.5">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-300" />
            </div>
            <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-md border border-slate-800/90 bg-slate-900/70 px-3.5 py-2.5">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
              </span>
              <span className="text-[12px] text-slate-400">{stageCopy}…</span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
            Pipeline error: {error}
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Composer                                                         */}
      {/* ---------------------------------------------------------------- */}
      <div className="space-y-3 border-t border-slate-800/70 bg-slate-950/40 p-4">
        <ScenarioBar onSelect={runScenario} disabled={busy} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(input);
          }}
          className="flex items-end gap-2 rounded-2xl border border-slate-700/70 bg-slate-900/70 p-2 transition-colors focus-within:border-sky-500/60"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            disabled={busy}
            placeholder="Ask about an order, request a refund, or escalate to a human…"
            className="scroll-thin max-h-28 min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-[13.5px] text-slate-100 placeholder:text-slate-600 focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || input.trim().length === 0}
            className={cn('btn-primary h-[38px] w-[38px] shrink-0 !px-0')}
            aria-label="Send message"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>

        <p className="flex items-center justify-center gap-1.5 text-[10.5px] text-slate-600">
          <CornerDownLeft className="h-3 w-3" />
          Enter to send · Shift + Enter for a new line · Strands Decider 2B screens every turn
        </p>
      </div>
    </section>
  );
}
