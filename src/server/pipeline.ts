import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  DecisionLabel,
  GroundingResult,
  GuardrailState,
  PipelineAction,
  PipelineTrace,
  TelemetryEvent,
  TelemetryKind,
  TelemetryLevel,
  ToolInvocation,
} from '@/lib/types';
import { MODEL_COST, MODEL_NAMES } from '@/lib/constants';
import { bus } from './bus';
import { isLowConfidence, runDecider } from './decider';
import { groundParameters, isClarificationReply } from './grounding';
import { runMainAgent } from './main-agent';
import { GROUNDING_TOKEN, estimateExposure, seededJitter, sleep, toolInvocation } from './tools';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  The pipeline — Layer 1 → Layer 2 → Layer 3
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  Layer 1  Strands Decider 2B   deterministic gatekeeper (µs-scale)
 *  Layer 2  Tool grounding       only for write-intent turns
 *  Layer 3  Main agent           simulated Bedrock Claude 3.5 Sonnet
 *
 * Every decision point emits a telemetry event onto the shared bus so the
 * dashboard can render the decision *as it happens*.
 */

export interface TurnInput {
  message: string;
  history: ChatMessage[];
}

/** Local emitter bound to a single trace. */
function createEmitter(traceId: string) {
  const events: TelemetryEvent[] = [];
  return {
    events,
    emit(
      layer: TelemetryEvent['layer'],
      stage: string,
      kind: TelemetryKind,
      level: TelemetryLevel,
      title: string,
      message: string,
      extra: Partial<TelemetryEvent> = {},
    ): TelemetryEvent {
      const event: TelemetryEvent = {
        id: randomUUID(),
        traceId,
        seq: bus.nextSeq(),
        ts: Date.now(),
        layer,
        stage,
        kind,
        level,
        title,
        message,
        ...extra,
      };
      events.push(event);
      bus.publish(event);
      return event;
    },
  };
}

/** Short human label for a decision label. */
const LABEL_TEXT: Record<DecisionLabel, string> = {
  SAFE_INFO_REQUEST: 'Safe info request',
  POTENTIAL_FRAUD_ABUSE: 'Potential fraud / abuse',
  VALID_RETURN_REQUEST: 'Valid return request',
  HUMAN_ESCALATION: 'Human escalation',
};

/** Refusal copy used when the gate blocks a request. */
function composeBlockMessage(orderId: string | null, exposure: number): string {
  const target = orderId ? ` on order #${orderId}` : '';
  const value = exposure > 0 ? ` (${`$${exposure.toLocaleString('en-US')}`} of order value)` : '';
  return (
    `I'm not able to action that request.\n\n` +
    `Requests to override refund controls aren't something I can process${target}${value}, ` +
    `and no refund has been issued. The attempt has been recorded for our Trust & Safety team to review.\n\n` +
    `If there is a genuine issue with this order, I can absolutely help through the standard refund ` +
    `process — I just need the order ID, the item and the reason for the return.`
  );
}

/** Clarification copy used when grounding is incomplete. */
function composeClarificationMessage(missing: string[], reason?: string): string {
  const subject = reason ? `a refund for your ${reason}` : 'that refund';

  const phrase = (name: string) => {
    if (name === 'Order ID') return 'your Order ID';
    if (name === 'Item SKU') return 'the Item SKU';
    return 'the reason for the return';
  };

  // One question at a time, in the canonical Order ID → Item SKU → Reason
  // order. Everything still outstanding is named in the follow-up so the
  // customer always knows the full picture.
  const [first, ...rest] = missing;
  const ask = phrase(first);
  const outstanding = rest.map(phrase);

  return (
    `I can certainly help you with ${subject}. However, I need a bit more information first. ` +
    `Could you please provide ${ask}?\n\n` +
    `As soon as I have it${outstanding.length ? ` and ${outstanding.join(' and ')}` : ''}, ` +
    `I'll process the refund and the credit will land back on your original payment method ` +
    `in 3–5 business days. No refund has been issued yet.`
  );
}

/**
 * Process a single customer turn through the three-layer architecture.
 */
export async function processTurn(input: TurnInput): Promise<{ trace: PipelineTrace; events: TelemetryEvent[] }> {
  const traceId = randomUUID();
  const { events, emit } = createEmitter(traceId);
  const started = Date.now();

  /* ---------------------------------------------------------------- */
  /* Pre-flight                                                       */
  /* ---------------------------------------------------------------- */
  emit(0, 'TURN_RECEIVED', 'log', 'info', 'Turn received', input.message.slice(0, 120), {
    data: { chars: input.message.length, historyTurns: input.history.length },
  });

  /* ---------------------------------------------------------------- */
  /* LAYER 1 — Strands Decider 2B policy classifier                    */
  /* ---------------------------------------------------------------- */
  const deciderLatency = seededJitter(`decider:${input.message}`, 34, 58);
  emit(1, 'DECIDER_START', 'log', 'info', 'Layer 1 · policy classification', `${MODEL_NAMES.DECIDER_LABEL} forward pass`, {
    data: { model: MODEL_NAMES.DECIDER, targetLatencyMs: deciderLatency },
  });

  await sleep(deciderLatency);
  const decision = runDecider(input.message, deciderLatency);

  emit(
    1,
    'DECIDER_RESULT',
    'decision',
    decision.label === 'POTENTIAL_FRAUD_ABUSE' ? 'error' : 'success',
    `Classification · ${decision.label}`,
    `${LABEL_TEXT[decision.label]} — confidence ${(decision.confidence * 100).toFixed(1)}% in ${decision.latencyMs}ms`,
    {
      durationMs: decision.latencyMs,
      data: {
        label: decision.label,
        confidence: decision.confidence,
        probabilities: decision.probabilities,
        attributions: decision.attributions,
        inputTokens: decision.inputTokens,
        costUsd: decision.costUsd,
      },
    },
  );

  /* ---------------------------------------------------------------- */
  /* Routing                                                          */
  /* ---------------------------------------------------------------- */
  let guardrail: GuardrailState = 'GREEN';
  let action: PipelineAction = 'PROCEED_TO_MAIN_AGENT';
  let assistantMessage = '';
  let mainAgentInvoked = false;
  let mainAgentLatencyMs = 0;
  let mainAgentCost = 0;
  let preventedExposureUsd = 0;
  let grounding: GroundingResult = { approved: false, checks: [], missing: [], missingParams: [] };
  const tools: ToolInvocation[] = [];

  /**
   * A reply to a clarification question we asked ourselves carries almost no
   * linguistic signal ("10231", "the white sneakers"), so the 2B classifier
   * cannot be trusted to route it. The conversation context can: an answer to
   * our own question continues the workflow it belongs to. Layer 2 still has
   * the final say on whether the write is allowed.
   */
  const answeringOurQuestion = isClarificationReply(
    input.message,
    input.history,
    decision.attributions,
  );

  /**
   * Layer 2 — the tool-parameter grounding gate, followed by either the
   * deterministic clarification question or the Layer 3 refund workflow.
   */
  async function runGroundedTurn(): Promise<void> {
    const groundingStart = Date.now();
    grounding = groundParameters(input.message, input.history);

    emit(
      2,
      'GROUNDING_CHECK',
      'guard',
      grounding.approved ? 'success' : 'warn',
      grounding.approved
        ? 'Tool grounding approved'
        : `Missing parameters · ${grounding.missing.join(', ')}`,
      grounding.approved
        ? 'All required tool parameters explicitly grounded'
        : `Required parameters not stated by the customer: ${grounding.missing.join(', ')}`,
      {
        durationMs: Date.now() - groundingStart,
        data: {
          checks: grounding.checks,
          missing: grounding.missing,
          approved: grounding.approved,
        },
      },
    );

    if (!grounding.approved) {
      guardrail = 'AMBER';
      action = 'CLARIFY_GROUNDING';
      const attempted = {
        order_id: grounding.checks.find((c) => c.param === 'ORDER_ID')?.value ?? null,
        sku: grounding.checks.find((c) => c.param === 'ITEM_SKU')?.value ?? null,
        reason: grounding.checks.find((c) => c.param === 'REASON')?.value ?? null,
      };
      emit(
        2,
        'TOOL_HELD',
        'freeze',
        'warn',
        'execute_refund · HELD',
        `Tool held back — missing ${grounding.missing.join(', ')}. No write attempted.`,
        { data: { tool: 'execute_refund', args: attempted, frozen: true, reason: 'INCOMPLETE_GROUNDING' } },
      );
      tools.push(
        toolInvocation(
          'execute_refund',
          attempted,
          'skipped',
          0,
          undefined,
          `Grounding incomplete — missing ${grounding.missing.join(', ')}`,
        ),
      );
      assistantMessage = composeClarificationMessage(
        grounding.missing,
        grounding.checks.find((c) => c.param === 'REASON')?.value,
      );
      return;
    }

    guardrail = 'GREEN';
    action = 'PROCEED_TO_MAIN_AGENT';
    const outcome = await runMainAgent({
      label: 'VALID_RETURN_REQUEST',
      userMessage: input.message,
      grounding,
      authorisation: GROUNDING_TOKEN,
      emit: (event) => emit(event.layer, event.stage, event.kind, event.level, event.title, event.message, event),
    });
    assistantMessage = outcome.message;
    tools.push(...outcome.tools);
    mainAgentInvoked = true;
    mainAgentLatencyMs = outcome.latencyMs;
    mainAgentCost = outcome.costUsd;
  }

  /* ---------- FRAUD / ABUSE INTERCEPT (never reaches Layer 3) ------ */
  if (decision.label === 'POTENTIAL_FRAUD_ABUSE') {
    guardrail = 'RED';
    action = 'BLOCKED_BY_GUARDRAIL';
    preventedExposureUsd = estimateExposure(input.message);
    const attemptedOrder = input.message.match(/\b(?:order|#)\s*#?(\d{3,})\b/i)?.[1] ?? null;

    emit(
      1,
      'GUARDRAIL_BLOCK',
      'guard',
      'error',
      'Intercept · POTENTIAL_FRAUD_ABUSE',
      'Prompt-injection / abuse signature detected — request terminated at Layer 1',
      {
        data: {
          attackSignals: decision.attributions.map((a) => a.feature),
          attemptedOrder,
          preventedExposureUsd,
        },
      },
    );

    emit(
      2,
      'TOOL_FROZEN',
      'freeze',
      'error',
      'execute_refund · FROZEN',
      `Tool execution blocked before entry — Layer 2/3 never reached`,
      {
        data: {
          tool: 'execute_refund',
          args: { order_id: attemptedOrder, sku: null, reason: null },
          frozen: true,
          attemptedOrder,
        },
      },
    );

    tools.push(
      toolInvocation(
        'execute_refund',
        { order_id: attemptedOrder, sku: null, reason: null },
        'frozen',
        0,
        undefined,
        'Guardrail RED — fraud signature intercepted at Layer 1',
      ),
    );

    assistantMessage = composeBlockMessage(attemptedOrder, preventedExposureUsd);
  } else if (answeringOurQuestion) {
    /* ---------- CONTINUATION OF A CLARIFICATION EXCHANGE ---------- */
    emit(
      1,
      'CLARIFICATION_REPLY',
      'decision',
      'info',
      'Clarification reply recognised',
      `Answer to our own question — continuing the refund workflow (classifier said ${decision.label} at ${(decision.confidence * 100).toFixed(1)}%)`,
      { data: { label: decision.label, confidence: decision.confidence } },
    );
    await runGroundedTurn();
  } else if (decision.label === 'HUMAN_ESCALATION' || isLowConfidence(decision)) {
    /* ---------- HUMAN ESCALATION ---------- */
    if (isLowConfidence(decision) && decision.label !== 'HUMAN_ESCALATION') {
      emit(
        1,
        'LOW_CONFIDENCE',
        'guard',
        'warn',
        'Low-confidence classification',
        `Confidence ${(decision.confidence * 100).toFixed(1)}% is below the ${(0.5 * 100).toFixed(0)}% threshold — failing safe to a human`,
        { data: { confidence: decision.confidence, threshold: 0.5 } },
      );
    }
    guardrail = 'AMBER';
    action = 'ESCALATED_TO_HUMAN';
    const outcome = await runMainAgent({
      label: 'HUMAN_ESCALATION',
      userMessage: input.message,
      grounding,
      authorisation: null,
      emit: (event) => emit(event.layer, event.stage, event.kind, event.level, event.title, event.message, event),
    });
    assistantMessage = outcome.message;
    tools.push(...outcome.tools);
    mainAgentInvoked = true;
    mainAgentLatencyMs = outcome.latencyMs;
    mainAgentCost = outcome.costUsd;
  } else if (decision.label === 'VALID_RETURN_REQUEST') {
    /* ---------- LAYER 2 — TOOL PARAMETER GROUNDING ---------- */
    await runGroundedTurn();
  } else {
    /* ---------- SAFE INFO REQUEST (fast path) ---------- */
    guardrail = 'GREEN';
    action = 'PROCEED_TO_MAIN_AGENT';
    const outcome = await runMainAgent({
      label: 'SAFE_INFO_REQUEST',
      userMessage: input.message,
      grounding,
      authorisation: GROUNDING_TOKEN,
      emit: (event) => emit(event.layer, event.stage, event.kind, event.level, event.title, event.message, event),
    });
    assistantMessage = outcome.message;
    tools.push(...outcome.tools);
    mainAgentInvoked = true;
    mainAgentLatencyMs = outcome.latencyMs;
    mainAgentCost = outcome.costUsd;
  }

  /* ---------------------------------------------------------------- */
  /* Accounting                                                       */
  /* ---------------------------------------------------------------- */
  const executedTools = tools.filter((t) => t.status === 'executed').length;
  const toolCost = executedTools * MODEL_COST.TOOL_USD;
  const costSpentUsd = decision.costUsd + mainAgentCost + toolCost;
  const baselineCostUsd = MODEL_COST.MAIN_AGENT_USD;
  const costSavedUsd = Math.max(0, baselineCostUsd - costSpentUsd);
  const costSavedPct = baselineCostUsd > 0 ? costSavedUsd / baselineCostUsd : 0;
  const totalLatencyMs = Date.now() - started;

  emit(
    0,
    'TURN_COMPLETE',
    'metric',
    'success',
    'Turn complete',
    `${decision.label} · ${totalLatencyMs}ms · $${costSpentUsd.toFixed(4)} spent · $${costSavedUsd.toFixed(4)} saved`,
    {
      durationMs: totalLatencyMs,
      data: {
        label: decision.label,
        action,
        guardrail,
        deciderLatencyMs: decision.latencyMs,
        mainAgentLatencyMs,
        mainAgentInvoked,
        costSpentUsd,
        costSavedUsd,
        costSavedPct,
        preventedExposureUsd,
      },
    },
  );

  return {
    trace: {
      traceId,
      userMessage: input.message,
      decision,
      grounding,
      guardrail,
      action,
      mainAgentLatencyMs,
      totalLatencyMs,
      costSpentUsd,
      baselineCostUsd,
      costSavedUsd,
      costSavedPct,
      mainAgentInvoked,
      tools,
      preventedExposureUsd,
      assistantMessage,
    },
    events,
  };
}
