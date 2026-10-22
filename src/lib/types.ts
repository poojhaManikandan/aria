/**
 * Shared type definitions for the Autonomous E-Commerce Support & Fraud-Guard Agent.
 *
 * These types are imported by BOTH the server-side mock pipeline and the
 * React client, so this module must stay dependency-free and isomorphic.
 */

/* ------------------------------------------------------------------ */
/* Layer 1 — Strands Decider 2B policy classifier                     */
/* ------------------------------------------------------------------ */

/** The four decision labels the 2B pointer model can emit. */
export type DecisionLabel =
  | 'SAFE_INFO_REQUEST'
  | 'POTENTIAL_FRAUD_ABUSE'
  | 'VALID_RETURN_REQUEST'
  | 'HUMAN_ESCALATION';

export const DECISION_LABELS: DecisionLabel[] = [
  'SAFE_INFO_REQUEST',
  'POTENTIAL_FRAUD_ABUSE',
  'VALID_RETURN_REQUEST',
  'HUMAN_ESCALATION',
];

/** A single "pointer" — i.e. one lexical/attention feature that pulls the 2B head. */
export interface Attribution {
  /** Human readable name of the semantic feature that fired. */
  feature: string;
  /** The surface token / phrase that triggered the feature. */
  trigger: string;
  /** Signed contribution to the label logit. */
  weight: number;
  /** Which label prototype this feature points at. */
  label: DecisionLabel;
}

/** Full Layer-1 output: softmax distribution + winner + calibrated confidence. */
export interface DeciderDecision {
  model: string;
  label: DecisionLabel;
  /** Calibrated confidence in [0,1] for the winning label. */
  confidence: number;
  /** Softmax probability per label (sums to 1). */
  probabilities: Record<DecisionLabel, number>;
  /** Raw (pre-softmax) score per label. */
  scores: Record<DecisionLabel, number>;
  /** Top pointers that fired, sorted by |weight|. */
  attributions: Attribution[];
  /** Simulated wall-clock latency of the 2B forward pass, in milliseconds. */
  latencyMs: number;
  /** Prompt tokens seen by the (mock) tokeniser. */
  inputTokens: number;
  /** Simulated cost of one 2B execution, in USD. */
  costUsd: number;
}

/* ------------------------------------------------------------------ */
/* Layer 2 — Tool parameter grounding                                   */
/* ------------------------------------------------------------------ */

export type GroundingParam = 'ORDER_ID' | 'ITEM_SKU' | 'REASON';

export interface GroundingCheck {
  param: GroundingParam;
  /** Human readable name, e.g. "Order ID". */
  label: string;
  present: boolean;
  /** The grounded value, when present. */
  value?: string;
  /** Where the value was found — explicit in the current turn, or in history. */
  source?: 'current_message' | 'chat_context' | 'catalog' | 'policy';
  /** 0..1 — how strongly the parameter was grounded. */
  confidence: number;
}

export interface GroundingResult {
  /** True only when every required parameter is explicitly grounded. */
  approved: boolean;
  checks: GroundingCheck[];
  /** Human names of the missing parameters, in canonical order. */
  missing: string[];
  /** Machine names of the missing parameters (used to scope chat-context grounding). */
  missingParams: GroundingParam[];
}

/* ------------------------------------------------------------------ */
/* Layer 3 — Main agent (simulated Bedrock Claude 3.5 Sonnet)         */
/* ------------------------------------------------------------------ */

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  status: 'executed' | 'frozen' | 'skipped' | 'failed';
  latencyMs: number;
  result?: unknown;
  /** Populated when the invocation was blocked by a guardrail. */
  blockedReason?: string;
}

/* ------------------------------------------------------------------ */
/* Telemetry event stream                                               */
/* ------------------------------------------------------------------ */

export type TelemetryLayer = 0 | 1 | 2 | 3;

export type TelemetryKind =
  | 'log'
  | 'metric'
  | 'decision'
  | 'guard'
  | 'tool'
  | 'freeze'
  | 'latency';

export type TelemetryLevel = 'info' | 'success' | 'warn' | 'error';

export interface TelemetryEvent {
  /** Unique event id — used by the client to de-duplicate SSE + HTTP events. */
  id: string;
  /** Groups every event belonging to one customer turn. */
  traceId: string;
  /** Monotonic sequence number within the session. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  layer: TelemetryLayer;
  /** Short machine-ish stage name, e.g. "DECIDER_FORWARD". */
  stage: string;
  kind: TelemetryKind;
  level: TelemetryLevel;
  title: string;
  message: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export type GuardrailState = 'GREEN' | 'AMBER' | 'RED';

/** The terminal action taken by the pipeline for one customer turn. */
export type PipelineAction =
  | 'PROCEED_TO_MAIN_AGENT'
  | 'CLARIFY_GROUNDING'
  | 'BLOCKED_BY_GUARDRAIL'
  | 'ESCALATED_TO_HUMAN';

/* ------------------------------------------------------------------ */
/* Chat                                                                 */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  /**
   * When the assistant had to ask a clarification question, this lists the
   * tool parameters it asked for. Layer 2 only permits chat-context grounding
   * for slots the agent explicitly requested in its previous turn — this stops
   * a stale order/SKU from an older conversation silently grounding a new
   * refund request.
   */
  requests?: GroundingParam[];
  /**
   * Slots that were already grounded when the assistant asked its
   * clarification question. Layer 2 uses this to carry a resolved slot across
   * the turns of a single clarification exchange, without ever resurrecting a
   * value from an older, unrelated request.
   */
  resolved?: Partial<Record<GroundingParam, string>>;
}

/* ------------------------------------------------------------------ */
/* Trace — everything the telemetry panel renders for one turn          */
/* ------------------------------------------------------------------ */

export interface PipelineTrace {
  traceId: string;
  userMessage: string;
  decision: DeciderDecision;
  grounding: GroundingResult;
  guardrail: GuardrailState;
  action: PipelineAction;
  /** Wall-clock latency of the main agent turn, 0 when never invoked. */
  mainAgentLatencyMs: number;
  /** End-to-end wall-clock latency of the turn. */
  totalLatencyMs: number;
  /** USD actually spent on this turn (decider + main agent + tools). */
  costSpentUsd: number;
  /** USD that a naive "always call the big LLM" pipeline would have spent. */
  baselineCostUsd: number;
  /** USD avoided on this turn. */
  costSavedUsd: number;
  /** Fraction of the baseline budget avoided (0..1). */
  costSavedPct: number;
  mainAgentInvoked: boolean;
  tools: ToolInvocation[];
  /** Fraud value that the guardrail protected, when it could be estimated. */
  preventedExposureUsd: number;
  assistantMessage: string;
}

export interface ChatResponse {
  trace: PipelineTrace;
  events: TelemetryEvent[];
}

/* ------------------------------------------------------------------ */
/* Cumulative session metrics (surfaced in the telemetry header)       */
/* ------------------------------------------------------------------ */

export interface SessionMetrics {
  turns: number;
  blocked: number;
  escalated: number;
  grounded: number;
  ungrounded: number;
  toolCalls: number;
  frozenToolCalls: number;
  deciderLatencyMsAvg: number;
  mainAgentLatencyMsAvg: number;
  costSpentUsd: number;
  costSavedUsd: number;
  costSavedPct: number;
  preventedExposureUsd: number;
}
