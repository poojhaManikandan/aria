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

/**
 * Customer-facing copy used whenever Layer 3 cannot finish a turn. Keeping the
 * wording here means the pipeline wrapper and the agent-level wrapper agree.
 */
export const MAIN_AGENT_FALLBACK_MESSAGE =
  'I hit a temporary issue while completing that request, so no action was taken. ' +
  'Please try again in a moment — or ask me to pass this to a human agent and I will open a ticket.';

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

function composeGeneralAnswer(userMessage: string): string {
  const lower = userMessage.toLowerCase().trim();

  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(lower)) {
    return (
      `Hi! I can help with order tracking, refunds, returns and product questions. ` +
      `Share an order number (for example #99482) or tell me what you need.`
    );
  }

  if (/(what can you do|how can you help|what do you do|who are you|help me)/.test(lower)) {
    return (
      `I can look up orders, explain shipping status, start a return or refund, and answer product questions. ` +
      `If you have an order number, share it and I'll pull up the details. If not, describe the issue and I'll guide you.`
    );
  }

  return (
    `Happy to help! Could you share the order number (it usually looks like #99482), ` +
    `or describe the issue you're seeing? For example: "where is my order #99482" or ` +
    `"refund order #12345 because it arrived damaged".`
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
async function runMainAgentImpl(ctx: MainAgentContext): Promise<MainAgentOutcome> {
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

    if (orderId) {
      const toolStart = Date.now();
      const order = await lookupOrder(orderId);
      const toolLatency = Date.now() - toolStart;

      tools.push(
        toolInvocation(
          'lookup_order',
          { order_id: orderId },
          'executed',
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
        message: `read-only lookup on #${orderId}`,
        durationMs: toolLatency,
        data: { tool: 'lookup_order', args: { order_id: orderId }, readOnly: true },
      });

      message = composeOrderStatusAnswer(orderId, order);
    } else {
      message = composeGeneralAnswer(ctx.userMessage);
    }
  } else if (ctx.label === 'VALID_RETURN_REQUEST') {
    /* --------------------- refund route --------------------------- */
    const orderId = ctx.grounding.checks.find((c) => c.param === 'ORDER_ID')?.value ?? '';
    const sku = ctx.grounding.checks.find((c) => c.param === 'ITEM_SKU')?.value ?? '';
    const reason = ctx.grounding.checks.find((c) => c.param === 'REASON')?.value ?? 'customer request';
    const lookupStart = Date.now();
    const order = await lookupOrder(orderId, sku);
    const lookupLatency = Date.now() - lookupStart;

    if (!order) {
      tools.push(
        toolInvocation('lookup_order', { order_id: orderId }, 'executed', lookupLatency, null),
      );
      ctx.emit({
        layer: 3,
        stage: 'POLICY_CHECK',
        kind: 'guard',
        level: 'warn',
        title: 'Order lookup failed',
        message: `No order matches #${orderId} — asking the customer to confirm the number.`,
        data: { orderId },
      });
      message =
        `I couldn't find an order matching **#${orderId}** in our ledger — could you double-check the number? ` +
        `It usually looks like five digits (for example #99482). As soon as you share the right order, ` +
        `I'll continue the refund for ${reason}.`;
    } else {
      const orderTotal = order.total;

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
        const line = order.items.find(
          (item) => item.sku.toUpperCase() === sku.toUpperCase(),
        );

        if (!line) {
          tools.push(
            toolInvocation(
              'execute_refund',
              { order_id: orderId, sku, reason },
              'skipped',
              0,
              undefined,
              `SKU ${sku} is not present on order ${orderId}`,
            ),
          );
          ctx.emit({
            layer: 3,
            stage: 'POLICY_CHECK',
            kind: 'guard',
            level: 'warn',
            title: 'Item not on order',
            message: `Order #${orderId} does not contain ${sku} — asking the customer to confirm the SKU.`,
            data: { orderId, sku },
          });
          message =
            `I found order **#${orderId}**, but I couldn't match **${sku}** to the items on that order. ` +
            `Could you confirm the SKU exactly as it appears on your order confirmation ` +
            `(for example SHOE-BLU-01)? No refund has been issued yet.`;
        } else {
          const toolStart = Date.now();

          try {
            const refund = await executeRefund(
              { order_id: orderId, sku, reason },
              ctx.authorisation,
            );
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
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'Unknown refund tool failure';
            const toolLatency = Date.now() - toolStart;

            tools.push(
              toolInvocation(
                'execute_refund',
                { order_id: orderId, sku, reason },
                'failed',
                toolLatency,
                undefined,
                detail,
              ),
            );

            ctx.emit({
              layer: 3,
              stage: 'TOOL_ERROR',
              kind: 'tool',
              level: 'error',
              title: 'Tool · execute_refund failed',
              message: `No refund was issued for #${orderId} / ${sku}: ${detail}`,
              durationMs: toolLatency,
              data: {
                tool: 'execute_refund',
                args: { order_id: orderId, sku, reason },
                error: detail,
                refunded: false,
              },
            });

            message =
              `I wasn't able to complete the refund for **${sku}** on order **#${orderId}** just now, ` +
              `so no money has moved. The failure is logged and a human agent can pick it up. ` +
              `You can also try again in a moment — the item and reason are still on file.`;
          }
        }
      }
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

/**
 * Public Layer-3 entry point. Any unexpected failure in planning, lookups or
 * answer composition is converted into a graceful reply so the HTTP layer does
 * not surface a 500 for an otherwise recoverable turn.
 */
export async function runMainAgent(ctx: MainAgentContext): Promise<MainAgentOutcome> {
  const started = Date.now();

  try {
    return await runMainAgentImpl(ctx);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown main-agent failure';

    try {
      ctx.emit({
        layer: 3,
        stage: 'AGENT_FALLBACK',
        kind: 'log',
        level: 'error',
        title: 'Layer 3 recovered',
        message: `Main agent failed (${detail}) — returned a safe simulated response.`,
        durationMs: Date.now() - started,
        data: { error: detail, fallback: true },
      });
    } catch {
      // Telemetry must never be allowed to take down the turn.
    }

    return {
      message: MAIN_AGENT_FALLBACK_MESSAGE,
      tools: [],
      latencyMs: Date.now() - started,
      costUsd: 0,
    };
  }
}
