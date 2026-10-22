import type {
  DecisionLabel,
  GroundingResult,
  TelemetryKind,
  TelemetryLevel,
  ToolInvocation,
} from '@/lib/types';
import { MODEL_COST, MODEL_NAMES } from '@/lib/constants';
import {
  createSupportTicket,
  executeRefund,
  lookupOrder,
  seededJitter,
  sleep,
  toolInvocation,
} from './tools';
import { POLICY, findCatalogItem } from './knowledge';
import { extractOrderId } from './grounding';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  Layer 3 — Main Agent (simulated Bedrock Claude 3.5 Sonnet)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The expensive, high-quality model. It is only ever reached when Layer 1
 * classified the turn as safe and Layer 2 grounded every tool parameter.
 *
 * The behaviour is mocked — but the *shape* is faithful: plan → select tool →
 * call tool → compose answer, with realistic per-phase latencies and a
 * billed cost that shows up in the telemetry comparison.
 */

/** Callback used by the agent to publish telemetry while it works. */
export type AgentEmitter = (event: {
  layer: 3;
  stage: string;
  kind: TelemetryKind;
  level: TelemetryLevel;
  title: string;
  message: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}) => void;

export interface MainAgentContext {
  label: DecisionLabel;
  userMessage: string;
  grounding: GroundingResult;
  /** Layer-2 authorisation token — `null` when grounding failed. */
  authorisation: string | null;
  emit: AgentEmitter;
}

export interface MainAgentOutcome {
  message: string;
  tools: ToolInvocation[];
  latencyMs: number;
  costUsd: number;
}

/* ------------------------------------------------------------------ */
/* Answer composition                                                   */
/* ------------------------------------------------------------------ */

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function composeOrderStatusAnswer(orderId: string, order: Awaited<ReturnType<typeof lookupOrder>>) {
  if (!order) {
    return (
      `I can help you track that. I couldn't find an order matching **#${orderId}** in our ledger — ` +
      `could you double-check the number? It usually looks like five digits (for example #99482). ` +
      `Alternatively, the email address used at checkout gets me there just as fast.`
    );
  }

  const lines = order.items.map((item) => {
    const product = findCatalogItem(item.sku);
    return `- ${product?.name ?? item.sku} (${item.sku}) — ${money(item.price)} x${item.qty}`;
  });

  return (
    `Good news — I've located order **#${order.orderId}**.\n\n` +
    `- Status: ${order.status}\n` +
    `- Carrier: ${order.carrier} · tracking ${order.tracking}\n` +
    `- Estimated arrival: ${order.eta}\n` +
    `- Items:\n${lines.join('\n')}\n\n` +
    `The shipment is moving normally and nothing is flagged on the order. ` +
    `I'll keep an eye on the tracking for you — reply here any time and I'll re-check it instantly.`
  );
}

function composeRefundAnswer(
  refund: {
    transactionId: string;
    orderId: string;
    sku: string;
    itemName: string;
    amount: number;
    method: string;
  },
  reason: string,
) {
  return (
    `All set — your refund is processed.\n\n` +
    `- Transaction: **${refund.transactionId}**\n` +
    `- Item: ${refund.itemName} (${refund.sku})\n` +
    `- Amount: **${money(refund.amount)}**\n` +
    `- Reason on file: ${reason}\n` +
    `- Destination: ${refund.method}\n\n` +
    `Most banks post the credit within 3–5 business days. You'll get a confirmation email with the same transaction ID, and I'm here if anything looks off.`
  );
}

function composeEscalationAnswer(ticket: { ticketId: string; queue: string; eta: string }) {
  return (
    `I've escalated this to a senior agent — you're in the right hands.\n\n` +
    `- Ticket: **${ticket.ticketId}**\n` +
    `- Queue: ${ticket.queue}\n` +
    `- Availability: ${ticket.eta}\n\n` +
    `A human will pick this up with the full context I've already attached, so you won't have to repeat yourself. ` +
    `Anything you want me to add to the ticket before they call?`
  );
}

/* ------------------------------------------------------------------ */
/* The agent turn                                                       */
/* ------------------------------------------------------------------ */

/**
 * Execute one main-agent turn for the given route.
 */
export async function runMainAgent(ctx: MainAgentContext): Promise<MainAgentOutcome> {
  const started = Date.now();
  const tools: ToolInvocation[] = [];
  const seed = `main:${ctx.userMessage}`;

  ctx.emit({
    layer: 3,
    stage: 'AGENT_INVOKE',
    kind: 'log',
    level: 'info',
    title: 'Main agent invoked',
    message: `${MODEL_NAMES.MAIN_LABEL} · ${MODEL_NAMES.REGION}`,
    data: { model: MODEL_NAMES.MAIN, region: MODEL_NAMES.REGION },
  });

  // Phase 1 — reasoning / planning.
  const thinkMs = seededJitter(`${seed}:think`, 280, 380);
  await sleep(thinkMs);
  ctx.emit({
    layer: 3,
    stage: 'AGENT_THINK',
    kind: 'log',
    level: 'info',
    title: 'Planning',
    message:
      ctx.label === 'SAFE_INFO_REQUEST'
        ? 'Route: read-only order lookup (no write tools).'
        : ctx.label === 'VALID_RETURN_REQUEST'
          ? 'Route: refund workflow — parameters already grounded by Layer 2.'
          : 'Route: human handoff — drafting escalation context.',
    durationMs: thinkMs,
  });

  let message = '';

  if (ctx.label === 'SAFE_INFO_REQUEST') {
    /* ------------------- read-only lookup route ------------------- */
    const orderId = extractOrderId(ctx.userMessage);
    const toolStart = Date.now();
    const order = orderId ? await lookupOrder(orderId) : null;
    const toolLatency = Date.now() - toolStart;

    tools.push(
      toolInvocation(
        'lookup_order',
        orderId ? { order_id: orderId } : { order_id: null },
        orderId ? 'executed' : 'skipped',
        toolLatency,
        order ? { status: order.status, carrier: order.carrier, eta: order.eta } : null,
      ),
    );

    ctx.emit({
      layer: 3,
      stage: 'TOOL_CALL',
      kind: 'tool',
      level: 'success',
      title: 'Tool · lookup_order',
      message: orderId
        ? `read-only lookup on #${orderId}`
        : 'no order reference detected — asking the customer for it',
      durationMs: toolLatency,
      data: { tool: 'lookup_order', args: { order_id: orderId }, readOnly: true },
    });

    message = orderId
      ? composeOrderStatusAnswer(orderId, order)
      : `Happy to help! Could you share the order number you placed with (it looks like #99482)? ` +
        `I'll pull up its live status straight away.`;
  } else if (ctx.label === 'VALID_RETURN_REQUEST') {
    /* --------------------- refund route --------------------------- */
    const orderId = ctx.grounding.checks.find((c) => c.param === 'ORDER_ID')?.value ?? '';
    const sku = ctx.grounding.checks.find((c) => c.param === 'ITEM_SKU')?.value ?? '';
    const reason = ctx.grounding.checks.find((c) => c.param === 'REASON')?.value ?? 'customer request';
    const order = await lookupOrder(orderId);
    const orderTotal = order?.total ?? 0;

    ctx.emit({
      layer: 3,
      stage: 'POLICY_CHECK',
      kind: 'guard',
      level: orderTotal > POLICY.autoRefundCeilingUsd ? 'warn' : 'success',
      title: 'Refund policy check',
      message:
        orderTotal > POLICY.autoRefundCeilingUsd
          ? `Refund of ${money(orderTotal)} exceeds the ${money(POLICY.autoRefundCeilingUsd)} auto-approval ceiling — routing to a human.`
          : `${money(orderTotal)} refund is inside the ${money(POLICY.autoRefundCeilingUsd)} auto-approval ceiling.`,
      data: { orderTotal, ceiling: POLICY.autoRefundCeilingUsd },
    });

    if (orderTotal > POLICY.autoRefundCeilingUsd) {
      const ticket = await createSupportTicket(`Refund over ceiling — #${orderId}`, reason);
      tools.push(toolInvocation('create_support_ticket', { order_id: orderId, reason }, 'executed', 140, ticket));
      ctx.emit({
        layer: 3,
        stage: 'TOOL_CALL',
        kind: 'tool',
        level: 'warn',
        title: 'Tool · create_support_ticket',
        message: `${ticket.ticketId} created in ${ticket.queue}`,
        data: { tool: 'create_support_ticket', args: { order_id: orderId } },
      });
      message =
        `I can process this one for you, but because the refund total (${money(orderTotal)}) is above my ` +
        `automatic approval limit of ${money(POLICY.autoRefundCeilingUsd)}, I've sent it to a senior agent ` +
        `who can authorise it. Ticket **${ticket.ticketId}** is open now — they'll action it during ${ticket.eta}.`;
    } else {
      const toolStart = Date.now();
      const refund = await executeRefund({ order_id: orderId, sku, reason }, ctx.authorisation);
      const toolLatency = Date.now() - toolStart;

      tools.push(
        toolInvocation(
          'execute_refund',
          { order_id: orderId, sku, reason },
          'executed',
          toolLatency,
          refund,
        ),
      );

      ctx.emit({
        layer: 3,
        stage: 'TOOL_CALL',
        kind: 'tool',
        level: 'success',
        title: 'Tool · execute_refund',
        message: `${refund.transactionId} · ${money(refund.amount)} → ${refund.sku}`,
        durationMs: toolLatency,
        data: {
          tool: 'execute_refund',
          args: { order_id: orderId, sku },
          transactionId: refund.transactionId,
          amount: refund.amount,
        },
      });

      message = composeRefundAnswer(refund, reason);
    }
  } else {
    /* -------------------- escalation route ------------------------ */
    const subject = `Escalation — ${ctx.label}`;
    const ticket = await createSupportTicket(subject, ctx.userMessage);
    tools.push(
      toolInvocation('create_support_ticket', { subject, reason: ctx.userMessage }, 'executed', 150, ticket),
    );
    ctx.emit({
      layer: 3,
      stage: 'TOOL_CALL',
      kind: 'tool',
      level: 'warn',
      title: 'Tool · create_support_ticket',
      message: `${ticket.ticketId} · ${ticket.queue}`,
      data: { tool: 'create_support_ticket', args: { subject } },
    });
    message = composeEscalationAnswer(ticket);
  }

  // Phase 3 — answer composition / streaming.
  const composeMs = seededJitter(`${seed}:compose`, 620, 840);
  await sleep(composeMs);
  ctx.emit({
    layer: 3,
    stage: 'AGENT_COMPLETE',
    kind: 'log',
    level: 'success',
    title: 'Answer ready',
    message: `${ctx.label.replace(/_/g, ' ').toLowerCase()} response composed`,
    durationMs: composeMs,
  });

  const latencyMs = Date.now() - started;
  return {
    message,
    tools,
    latencyMs,
    costUsd: MODEL_COST.MAIN_AGENT_USD,
  };
}
