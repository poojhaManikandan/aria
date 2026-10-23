import type {
  ChatMessage,
  ClarificationTrace,
  GroundingParam,
  WorkflowState,
} from '@/lib/types';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  Explicit refund workflow state machine
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The pipeline is stateless between HTTP requests, so the open clarification
 * exchange is reconstructed deterministically from the transcript:
 *
 *   REQUEST_RECEIVED → CLASSIFIED → PARAMETERS_EXTRACTED
 *     → PARAMETERS_VALIDATED → READY_TO_EXECUTE
 *
 * When a slot is missing or invalid the turn parks in AWAITING_CLARIFICATION.
 * The next customer reply re-enters at PARAMETERS_EXTRACTED. A hard retry limit
 * prevents an open-ended question loop; after the limit the exchange closes and
 * the request is escalated to a human instead of asking the same thing forever.
 */

export const MAX_CLARIFICATION_ATTEMPTS = 3;

export function getClarificationTrace(history: ChatMessage[]): ClarificationTrace {
  const chain: ChatMessage[] = [];

  // Walk backwards over the contiguous clarification turns. The first assistant
  // turn that is not a clarification (a receipt, a ticket, a normal answer)
  // closes the exchange.
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'assistant') continue;
    if (!turn.requests?.length) break;
    chain.push(turn);
  }

  const requested = new Set<GroundingParam>();
  for (const turn of chain) {
    for (const param of turn.requests ?? []) requested.add(param);
  }

  return {
    attempt: chain.length,
    maxAttempts: MAX_CLARIFICATION_ATTEMPTS,
    requested: [...requested],
    resolved: chain[0]?.resolved ?? {},
    exhausted: chain.length >= MAX_CLARIFICATION_ATTEMPTS,
  };
}

/** Final trace state for a turn that has completed (or was blocked). */
export function finalWorkflowState(
  action: 'PROCEED_TO_MAIN_AGENT' | 'CLARIFY_GROUNDING' | 'BLOCKED_BY_GUARDRAIL' | 'ESCALATED_TO_HUMAN',
  refundExecuted: boolean,
  ticketCreated: boolean,
): WorkflowState {
  if (action === 'BLOCKED_BY_GUARDRAIL') return 'BLOCKED';
  if (action === 'CLARIFY_GROUNDING') return 'AWAITING_CLARIFICATION';
  if (refundExecuted) return 'EXECUTED';
  if (ticketCreated || action === 'ESCALATED_TO_HUMAN') return 'ESCALATED';
  return 'READY_TO_EXECUTE';
}
