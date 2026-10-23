import type { ToolInvocation } from '@/lib/types';
import { MODEL_COST } from '@/lib/constants';
import { CATALOG, POLICY, findCatalogItem, resolveOrder, type MockOrder } from './knowledge';
import { fnv1a } from './decider';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  Deterministic tool layer (mock commerce services)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * These tools are the "money-moving" side of the agent. They are written so
 * that they CANNOT be called without an explicit guardrail authorisation —
 * a defence-in-depth control that mirrors how real production systems wrap
 * high-risk actions behind a policy service.
 */

/** Raised when a tool is invoked without a valid guardrail authorisation. */
export class GuardrailViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailViolation';
  }
}

/** Token issued by Layer 2 when every required parameter is grounded. */
export const GROUNDING_TOKEN = 'GROUNDING_APPROVED::v1';

export interface RefundToolArgs {
  order_id: string;
  sku: string;
  reason: string;
}

export interface RefundToolResult {
  transactionId: string;
  orderId: string;
  sku: string;
  itemName: string;
  amount: number;
  currency: 'USD';
  status: 'REFUNDED';
  processedAt: string;
  method: string;
}

/** Deterministic jitter derived from a seed (keeps demo timings reproducible). */
export function seededJitter(seed: string, min: number, max: number): number {
  const t = (fnv1a(seed) % 1000) / 1000;
  return Math.round(min + t * (max - min));
}

/** Sleep helper used to simulate model / tool latency. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Read-only order lookup. Safe to call from the main agent.
 */
export async function lookupOrder(orderId: string, sku?: string): Promise<MockOrder | null> {
  await sleep(seededJitter(`lookup:${orderId}`, 70, 210));
  return orderId.trim() ? resolveOrder(orderId, sku) : null;
}

/**
 * Refund execution tool.
 *
 * `authorisation` is the guardrail token produced by Layer 2. Without it the
 * call is rejected — which is exactly what happens to Scenario B (fraud) and
 * Scenario C (ungrounded): the tool is never even entered.
 */
export async function executeRefund(
  args: RefundToolArgs,
  authorisation: string | null,
): Promise<RefundToolResult> {
  if (authorisation !== GROUNDING_TOKEN) {
    throw new GuardrailViolation(
      'Tool execution frozen: Layer 2 grounding authorisation missing.',
    );
  }

  await sleep(seededJitter(`refund:${args.order_id}:${args.sku}`, 90, 240));

  const order = resolveOrder(args.order_id, args.sku);
  const line = order.items.find((item) => item.sku.toUpperCase() === args.sku.toUpperCase());
  if (!line) {
    throw new Error(`SKU ${args.sku} is not present on order ${args.order_id}.`);
  }

  const item = findCatalogItem(line.sku);
  const transactionId = `RFD-${fnv1a(`${order.orderId}:${line.sku}`).toString(16).toUpperCase().slice(0, 8)}`;

  return {
    transactionId,
    orderId: order.orderId,
    sku: line.sku,
    itemName: item?.name ?? line.sku,
    amount: line.price,
    currency: 'USD',
    status: 'REFUNDED',
    processedAt: new Date().toISOString(),
    method: `Original payment method (${order.carrier} ···· ${order.tracking.slice(-4)})`,
  };
}

/**
 * Create a human-hand-off ticket (used by the escalation path).
 */
export async function createSupportTicket(
  subject: string,
  reason: string,
): Promise<{ ticketId: string; queue: string; eta: string; summary: string }> {
  await sleep(seededJitter(`ticket:${subject}`, 110, 260));
  const ticketId = `TKT-${fnv1a(subject).toString(36).toUpperCase().slice(0, 7)}`;
  return {
    ticketId,
    queue: 'Tier-2 Trust & Safety',
    eta: POLICY.supportHours,
    summary: reason.slice(0, 160),
  };
}

/**
 * Estimate the financial exposure of an abusive request so the telemetry can
 * display "fraud value prevented" without ever touching the main agent.
 */
export function estimateExposure(text: string): number {
  const idMatch = /\b(?:order|#)\s*#?(\d{3,})\b/i.exec(text);
  if (!idMatch) return 0;
  return resolveOrder(idMatch[1]).total;
}

/** Catalog lookup used by the main agent when explaining a product. */
export function findProduct(sku: string) {
  return CATALOG.find((c) => c.sku.toLowerCase() === sku.toLowerCase());
}

/** Tool metadata for the telemetry panel. */
export const TOOL_COST_USD = MODEL_COST.TOOL_USD;

/** Helper to build a ToolInvocation record. */
export function toolInvocation(
  name: string,
  args: Record<string, unknown>,
  status: ToolInvocation['status'],
  latencyMs: number,
  result?: unknown,
  blockedReason?: string,
): ToolInvocation {
  return { name, args, status, latencyMs, result, blockedReason };
}
