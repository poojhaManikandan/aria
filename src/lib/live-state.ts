import type {
  Attribution,
  DecisionLabel,
  GroundingResult,
  GuardrailState,
  PipelineTrace,
  SessionMetrics,
  TelemetryEvent,
  ToolInvocation,
} from './types';
import { DECISION_LABELS } from './types';

/**
 * Derives the *live* dashboard state from the telemetry event stream.
 *
 * The dashboard never guesses: every number it shows is either read from an
 * event payload or aggregated from completed traces.
 */

export interface LiveState {
  /** Trace currently being displayed (the most recent turn). */
  traceId: string | null;
  label: DecisionLabel | null;
  confidence: number;
  probabilities: Record<DecisionLabel, number> | null;
  attributions: Attribution[];
  guardrail: GuardrailState;
  grounding: GroundingResult | null;
  tools: ToolInvocation[];
  deciderLatencyMs: number;
  mainAgentLatencyMs: number;
  totalLatencyMs: number;
  costSpentUsd: number;
  costSavedUsd: number;
  preventedExposureUsd: number;
  mainAgentInvoked: boolean;
  blocked: boolean;
  /** Name of the last pipeline stage that fired. */
  stage: string;
  /** True while a turn is in flight. */
  inFlight: boolean;
  /** True once the turn has been fully accounted for. */
  complete: boolean;
}

const EMPTY_LIVE: LiveState = {
  traceId: null,
  label: null,
  confidence: 0,
  probabilities: null,
  attributions: [],
  guardrail: 'GREEN',
  grounding: null,
  tools: [],
  deciderLatencyMs: 0,
  mainAgentLatencyMs: 0,
  totalLatencyMs: 0,
  costSpentUsd: 0,
  costSavedUsd: 0,
  preventedExposureUsd: 0,
  mainAgentInvoked: false,
  blocked: false,
  stage: 'IDLE',
  inFlight: false,
  complete: false,
};

export function deriveLiveState(events: TelemetryEvent[]): LiveState {
  if (events.length === 0) return EMPTY_LIVE;

  const traceId = events[events.length - 1].traceId;
  const traceEvents = events.filter((event) => event.traceId === traceId);

  // Fresh arrays — never share references with EMPTY_LIVE.
  const state: LiveState = {
    ...EMPTY_LIVE,
    traceId,
    tools: [],
    attributions: [],
    inFlight: true,
  };

  for (const event of traceEvents) {
    state.stage = event.stage;

    switch (event.stage) {
      case 'DECIDER_RESULT': {
        const data = event.data as
          | {
              label: DecisionLabel;
              confidence: number;
              probabilities: Record<DecisionLabel, number>;
              attributions: Attribution[];
            }
          | undefined;
        if (data) {
          state.label = data.label;
          state.confidence = data.confidence;
          state.probabilities = data.probabilities;
          state.attributions = data.attributions ?? [];
        }
        state.deciderLatencyMs = event.durationMs ?? 0;
        break;
      }

      case 'GROUNDING_CHECK': {
        const data = event.data as
          | { checks: GroundingResult['checks']; missing: string[]; approved: boolean }
          | undefined;
        if (data) {
          state.grounding = {
            approved: data.approved,
            checks: data.checks,
            missing: data.missing,
            missingParams: data.checks.filter((c) => !c.present).map((c) => c.param),
          };
        }
        break;
      }

      case 'GUARDRAIL_BLOCK': {
        state.guardrail = 'RED';
        state.blocked = true;
        const data = event.data as { preventedExposureUsd?: number } | undefined;
        if (data?.preventedExposureUsd) state.preventedExposureUsd = data.preventedExposureUsd;
        break;
      }

      case 'TOOL_FROZEN': {
        state.guardrail = 'RED';
        state.blocked = true;
        const data = event.data as { tool?: string; args?: Record<string, unknown> } | undefined;
        state.tools.push({
          name: data?.tool ?? 'execute_refund',
          args: data?.args ?? {},
          status: 'frozen',
          latencyMs: event.durationMs ?? 0,
          blockedReason: 'Guardrail RED — frozen before tool entry',
        });
        break;
      }

      case 'TOOL_HELD': {
        state.guardrail = 'AMBER';
        const data = event.data as { tool?: string; args?: Record<string, unknown> } | undefined;
        state.tools.push({
          name: data?.tool ?? 'execute_refund',
          args: data?.args ?? {},
          status: 'skipped',
          latencyMs: 0,
          blockedReason: 'Grounding incomplete — tool held back',
        });
        break;
      }

      case 'TOOL_CALL': {
        const data = event.data as { tool?: string; args?: Record<string, unknown> } | undefined;
        state.tools.push({
          name: data?.tool ?? 'tool',
          args: data?.args ?? {},
          status: 'executed',
          latencyMs: event.durationMs ?? 0,
        });
        break;
      }

      case 'AGENT_INVOKE': {
        state.mainAgentInvoked = true;
        break;
      }

      case 'AGENT_COMPLETE': {
        state.mainAgentLatencyMs = event.durationMs ?? 0;
        break;
      }

      case 'TURN_COMPLETE': {
        const data = event.data as
          | {
              deciderLatencyMs?: number;
              mainAgentLatencyMs?: number;
              costSpentUsd?: number;
              costSavedUsd?: number;
              preventedExposureUsd?: number;
              guardrail?: GuardrailState;
              mainAgentInvoked?: boolean;
            }
          | undefined;
        state.complete = true;
        state.inFlight = false;
        if (data) {
          state.deciderLatencyMs = data.deciderLatencyMs ?? state.deciderLatencyMs;
          state.mainAgentLatencyMs = data.mainAgentLatencyMs ?? state.mainAgentLatencyMs;
          state.costSpentUsd = data.costSpentUsd ?? 0;
          state.costSavedUsd = data.costSavedUsd ?? 0;
          state.preventedExposureUsd = data.preventedExposureUsd ?? state.preventedExposureUsd;
          state.mainAgentInvoked = data.mainAgentInvoked ?? state.mainAgentInvoked;
          if (data.guardrail && !state.blocked) state.guardrail = data.guardrail;
        }
        break;
      }

      default:
        break;
    }
  }

  if (state.complete) state.inFlight = false;

  return state;
}

/**
 * Aggregate session metrics across every completed turn.
 */
export function aggregateMetrics(traces: PipelineTrace[]): SessionMetrics {
  const metrics: SessionMetrics = {
    turns: traces.length,
    agentInvocations: 0,
    clarifications: 0,
    blocked: 0,
    escalated: 0,
    grounded: 0,
    ungrounded: 0,
    toolCalls: 0,
    frozenToolCalls: 0,
    deciderLatencyMsAvg: 0,
    mainAgentLatencyMsAvg: 0,
    costSpentUsd: 0,
    costSavedUsd: 0,
    costSavedPct: 0,
    preventedExposureUsd: 0,
  };

  if (traces.length === 0) return metrics;

  let deciderTotal = 0;
  let mainTotal = 0;
  let mainTurns = 0;
  let baselineTotal = 0;

  for (const trace of traces) {
    if (trace.mainAgentInvoked) metrics.agentInvocations += 1;
    if (trace.action === 'CLARIFY_GROUNDING') metrics.clarifications += 1;
    if (trace.decision.label === 'POTENTIAL_FRAUD_ABUSE') metrics.blocked += 1;
    if (trace.action === 'ESCALATED_TO_HUMAN') metrics.escalated += 1;
    if (trace.action === 'CLARIFY_GROUNDING') metrics.ungrounded += 1;
    if (trace.grounding.approved) metrics.grounded += 1;

    for (const tool of trace.tools) {
      if (tool.status === 'executed') metrics.toolCalls += 1;
      if (tool.status === 'frozen') metrics.frozenToolCalls += 1;
    }

    deciderTotal += trace.decision.latencyMs;
    // Only turns where the agent actually ran count towards its average —
    // averaging in the 0 ms of blocked turns understates it.
    if (trace.mainAgentInvoked && trace.mainAgentLatencyMs > 0) {
      mainTotal += trace.mainAgentLatencyMs;
      mainTurns += 1;
    }
    baselineTotal += trace.baselineCostUsd;
    metrics.costSpentUsd += trace.costSpentUsd;
    metrics.costSavedUsd += trace.costSavedUsd;
    metrics.preventedExposureUsd += trace.preventedExposureUsd;
  }

  metrics.deciderLatencyMsAvg = Math.round(deciderTotal / traces.length);
  metrics.mainAgentLatencyMsAvg = mainTurns > 0 ? Math.round(mainTotal / mainTurns) : 0;
  metrics.costSavedPct = baselineTotal > 0 ? metrics.costSavedUsd / baselineTotal : 0;

  return metrics;
}

/** Sorted label list with their probabilities, largest first. */
export function rankedLabels(
  probabilities: Record<DecisionLabel, number> | null,
): Array<{ label: DecisionLabel; probability: number }> {
  if (!probabilities) {
    return DECISION_LABELS.map((label) => ({ label, probability: 0 }));
  }
  return DECISION_LABELS.map((label) => ({ label, probability: probabilities[label] })).sort(
    (a, b) => b.probability - a.probability,
  );
}
