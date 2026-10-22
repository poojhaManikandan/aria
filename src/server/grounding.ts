import type {
  Attribution,
  ChatMessage,
  GroundingCheck,
  GroundingResult,
  GroundingParam,
} from '@/lib/types';
import { REQUIRED_PARAMS } from '@/lib/constants';
import { resolveProductToSku } from './knowledge';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  Layer 2 — Tool Parameter Grounding
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A classifier alone is not enough to safely execute a money-moving tool.
 * Before `execute_refund` is ever called, the pipeline verifies that every
 * parameter the tool requires was **explicitly stated by the customer** —
 * either in the current turn, or in a turn that answered the question we
 * asked for that very slot.
 *
 * Nothing is inferred, guessed or defaulted. If a slot is missing the tool is
 * simply not called, and the agent asks a deterministic clarification question
 * (no LLM spend, because this is a policy decision, not a language task).
 *
 * The chat-context rule is deliberately strict: a value mentioned in an
 * *older, unrelated* request (say an order-status lookup) is never allowed
 * to satisfy a refund slot that the customer was asked for and did not
 * answer. Only a genuine answer to our question counts.
 */

/** Reason keywords that constitute an explicit justification. */
const REASON_KEYWORDS = [
  'damaged',
  'broken',
  'defective',
  'faulty',
  'cracked',
  'torn',
  'scratched',
  'ripped',
  'malfunction',
  'not working',
  'stopped working',
  'wrong size',
  'wrong colour',
  'wrong color',
  'wrong item',
  'not as described',
  'not as advertised',
  'too small',
  'too large',
  "doesn't fit",
  'does not fit',
  'late',
  'never arrived',
  'never received',
  'not delivered',
  'missing item',
  'lost in transit',
  'poor quality',
];

/** Words that can look like an order id but never are. */
const ID_STOPWORDS = new Set([
  'of',
  'the',
  'a',
  'an',
  'is',
  'was',
  'for',
  'to',
  'in',
  'on',
  'my',
  'it',
  'i',
  'and',
  'that',
  'this',
  'please',
]);

/** Extract an order id from a chunk of text. Returns null when ambiguous. */
export function extractOrderId(text: string): string | null {
  const candidates: string[] = [];

  // "order #99482", "order id 99482", "order number: 99482", "order 99482"
  const explicit = /\borders?\s*(?:id\s*|no\.?\s*|number\s*|#)?\s*[:#]?\s*([a-z0-9][a-z0-9-]{2,})\b/gi;
  for (const match of text.matchAll(explicit)) {
    candidates.push(match[1]);
  }

  // Bare "#99482" style references.
  for (const match of text.matchAll(/(?:^|\s)#([a-z0-9][a-z0-9-]{2,})/gi)) {
    candidates.push(match[1]);
  }

  for (const candidate of candidates) {
    const value = candidate.trim().replace(/[^\w-]/g, '');
    if (value.length < 3) continue;
    if (ID_STOPWORDS.has(value.toLowerCase())) continue;
    // A valid reference contains at least one digit (order ids are numeric or
    // alphanumeric-with-digits); pure words are rejected as hallucinated.
    if (!/\d/.test(value)) continue;
    return value;
  }

  return null;
}

/** Extract an explicitly stated SKU code, if any. */
export function extractExplicitSku(text: string): string | null {
  const match = /\bsku[-\s:#]*([a-z0-9][a-z0-9-]{2,})/i.exec(text);
  if (!match) return null;
  return match[1].trim().toUpperCase();
}

/** Extract an explicit reason (keyword or free-text clause). */
export function extractReason(text: string): string | null {
  const lower = text.toLowerCase();

  // 1) Tight copula capture — "it arrived damaged", "the shoes are faulty".
  const copula =
    /\b(?:it|they|the (?:item|product|shoes?|sneakers?|pair|order|package))\s+(?:is|was|are|were)\s+([^.!?,;]{2,50})/i.exec(
      text,
    ) ?? /\b(?:it|they)\s+(?:arrived|came|got|was|is)\s+([^.!?,;]{2,50})/i.exec(text);
  if (copula) {
    const phrase = copula[1].trim();
    if (REASON_KEYWORDS.some((k) => phrase.toLowerCase().includes(k))) {
      return phrase;
    }
  }

  // 2) Keyword hit — build a tight phrase (keyword + the noun it qualifies).
  const NOUN_TAIL = [
    'item',
    'items',
    'shoe',
    'shoes',
    'sneaker',
    'sneakers',
    'pair',
    'product',
    'order',
    'package',
    'parcel',
    'box',
    'headphones',
    'backpack',
    'keyboard',
    'monitor',
    'bottle',
    'mat',
  ];

  for (const keyword of REASON_KEYWORDS) {
    const index = lower.indexOf(keyword);
    if (index === -1) continue;

    const after = text.slice(index + keyword.length);
    const tailMatch = /^\s+([a-z]+)/i.exec(after);
    const tail =
      tailMatch && NOUN_TAIL.includes(tailMatch[1].toLowerCase()) ? ` ${tailMatch[1]}` : '';
    return `${keyword}${tail}`;
  }

  // 3) Free-text justification: "because ...", "since ...", "the reason is ...".
  const clause = /\b(?:because|since|due to|the reason (?:is|was)|it'?s)\s+(.{3,90})/i.exec(text);
  if (clause) return clause[1].trim();


  return null;
}

/**
 * Extract a bare order number, e.g. the customer replying just "10231" after
 * the agent asked for an order ID. Amounts are stripped first so "$5000"
 * can never be mistaken for an order reference.
 */
export function extractBareOrderId(text: string): string | null {
  const withoutMoney = text.replace(/\$\s*[\d.,]+/g, ' ');
  const match = /\b(\d{4,})\b/.exec(withoutMoney);
  return match ? match[1] : null;
}

/** Extract a SKU-shaped token, e.g. "SHOE-WHT-02", in any casing. */
export function extractSkuShapedToken(text: string): string | null {
  const match = /\b([A-Za-z]{2,}[A-Za-z0-9]*-[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]{2,})?)\b/.exec(text);
  if (!match) return null;
  // Require at least one digit so hyphenated words can't masquerade as SKUs.
  return /\d/.test(match[1]) ? match[1].toUpperCase() : null;
}

/* ------------------------------------------------------------------ */
/* Is this turn an answer to our own question?                         */
/* ------------------------------------------------------------------ */

/**
 * Features that mean the customer is doing something *other* than answering
 * the slot we asked for — a tracking question, a price question, a demand for
 * a human. When one of these fires we must not reinterpret the turn as a
 * clarification reply.
 */
const NON_ANSWER_FEATURES = new Set([
  'shipment_tracking_query',
  'information_seeking',
  'price_inquiry',
  'human_agent_request',
  'service_escalation_emotion',
  'account_trap',
  'sensitive_escalation_topic',
  'formal_complaint',
]);

/**
 * Does this turn answer a clarification question the agent asked?
 *
 * A reply such as "10231" or "the white sneakers" carries almost no
 * linguistic signal, so the 2B classifier alone cannot tell whether it is a
 * continuation of a refund request or a fresh question. The conversation
 * context can: if the previous assistant turn asked for a slot and this
 * message supplies one of them, the customer is answering us.
 *
 * @param message       The customer's newest utterance.
 * @param history       Prior turns (oldest → newest).
 * @param attributions  Features the classifier fired on this turn.
 */
export function isClarificationReply(
  message: string,
  history: ChatMessage[],
  attributions: Attribution[] = [],
): boolean {
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  const requested = lastAssistant?.requests ?? [];
  if (!requested.length) return false;

  // The customer is clearly doing something else.
  if (attributions.some((a) => NON_ANSWER_FEATURES.has(a.feature))) return false;

  return requested.some((param) => {
    switch (param) {
      case 'ORDER_ID':
        return Boolean(extractOrderId(message) ?? extractBareOrderId(message));
      case 'ITEM_SKU':
        return Boolean(
          extractExplicitSku(message) ??
            resolveProductToSku(message)?.sku ??
            extractSkuShapedToken(message),
        );
      case 'REASON':
        return Boolean(extractReason(message));
      default:
        return false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Clarification-exchange scope                                       */
/* ------------------------------------------------------------------ */

/**
 * A value extracted from a chunk of text, together with where it came from.
 */
interface Extraction {
  value: string;
  /** `catalog` means the SKU was resolved through the product catalogue. */
  source: 'current_message' | 'catalog';
}

/** Text → value extractor used by the slot resolver. */
type Extractor = (text: string) => Extraction | null;

/**
 * The *clarification exchange* — the chain of assistant turns that asked the
 * customer for missing slots, ending at the most recent turn.
 *
 * The exchange is only open while the newest assistant turn is itself a
 * clarification. As soon as the agent completes an action (a refund receipt)
 * the exchange closes and no historical value may be reused again.
 */
interface ExchangeScope {
  /** The newest clarification turn of the open exchange. */
  clarification: ChatMessage | null;
  /** Index of the newest clarification turn that asked for a given slot. */
  askedAt(param: GroundingParam): number;
  /** User turns that came after a given history index (newest first). */
  turnsAfter(index: number): string[];
  /** A slot that was already resolved earlier in this exchange. */
  carried(param: GroundingParam): string | null;
}

/**
 * Build the scope of the current clarification exchange.
 *
 * Walking backwards from the newest turn, the exchange stays open while every
 * assistant turn in it is a clarification. The first assistant turn that is
 * *not* a clarification ends it — that is the boundary between "the customer
 * is still answering our question" and "the customer has moved on".
 */
function buildScope(turns: ChatMessage[]): ExchangeScope {
  const chain: Array<{ index: number; message: ChatMessage }> = [];

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role !== 'assistant') continue;
    if (!turn.requests?.length) break; // exchange closed by a completed action
    chain.push({ index: i, message: turn });
  }
  chain.reverse();

  const askedAt = (param: GroundingParam): number => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (chain[i].message.requests?.includes(param)) return chain[i].index;
    }
    return -1;
  };

  const turnsAfter = (index: number): string[] => {
    if (index < 0) return [];
    const out: string[] = [];
    // Newest first — the most recently stated value wins.
    for (let i = turns.length - 1; i > index; i -= 1) {
      if (turns[i].role === 'user') out.push(turns[i].content);
    }
    return out;
  };

  const newest = chain.length ? chain[chain.length - 1] : null;

  const carried = (param: GroundingParam): string | null => {
    if (!newest) return null;
    // If the newest clarification asked for this slot it is *not* resolved.
    if (newest.message.requests?.includes(param)) return null;
    return newest.message.resolved?.[param] ?? null;
  };

  return {
    clarification: newest?.message ?? null,
    askedAt,
    turnsAfter,
    carried,
  };
}

/**
 * Resolve one tool parameter.
 *
 * Priority order:
 *   1. The customer stated it in the current turn.
 *   2. The customer answered our question with a shorthand form ("10231"),
 *      but only when we are the ones who asked for that slot.
 *   3. The customer stated it in a turn that came *after* we asked for it —
 *      i.e. they actually answered the question. Anything stated before the
 *      question is ignored: an order id mentioned in an unrelated earlier
 *      request must never be resurrected to satisfy a refund slot.
 *   4. The slot was already resolved earlier in this exchange, so it is
 *      carried forward untouched.
 */
function resolveSlot(
  param: GroundingParam,
  currentMessage: string,
  scope: ExchangeScope,
  extractors: { strict: Extractor; shorthand?: Extractor },
): { value: string; source: GroundingCheck['source']; confidence: number } | null {
  /* 1 — stated right now */
  const direct = extractors.strict(currentMessage);
  if (direct) {
    return {
      value: direct.value,
      source: direct.source,
      confidence: direct.source === 'catalog' ? 0.9 : 0.98,
    };
  }

  const asked = scope.askedAt(param);

  /* 2 — shorthand answer to our own question */
  if (asked >= 0 && extractors.shorthand) {
    const shorthand = extractors.shorthand(currentMessage);
    if (shorthand) {
      return { value: shorthand.value, source: 'current_message', confidence: 0.9 };
    }
  }

  /* 3 — answered after we asked, never before */
  if (asked >= 0) {
    for (const text of scope.turnsAfter(asked)) {
      const found = extractors.strict(text) ?? extractors.shorthand?.(text) ?? null;
      if (found) return { value: found.value, source: 'chat_context', confidence: 0.86 };
    }
  }

  /* 4 — already resolved earlier in this exchange */
  const carried = scope.carried(param);
  if (carried) return { value: carried, source: 'chat_context', confidence: 0.8 };

  return null;
}

/**
 * Drop the trailing duplicate of the current message.
 *
 * The client echoes the message it is sending at the end of the history, so
 * the "turns after the question" scan would otherwise count the current turn
 * twice.
 */
function normaliseHistory(history: ChatMessage[], currentMessage: string): ChatMessage[] {
  const turns = [...history];
  const last = turns[turns.length - 1];
  if (last && last.role === 'user' && last.content.trim() === currentMessage.trim()) {
    turns.pop();
  }
  return turns;
}

/**
 * Layer 2 — evaluate the chat context for grounded tool parameters.
 *
 * Chat-context grounding is deliberately narrow. A value from an earlier turn
 * is only accepted for a slot the assistant explicitly asked for **and only
 * when the customer stated it after that question was asked**. A parameter
 * stated in the current message is always accepted.
 *
 * Without that gate, a customer who first asks "where is order #99482?" and
 * then says "I want a refund for my damaged item" would have the refund
 * silently executed against the old order — exactly the class of bug a
 * grounding layer exists to prevent.
 *
 * @param userMessage  The newest customer utterance.
 * @param history      Prior turns of the conversation (oldest → newest).
 */
export function groundParameters(userMessage: string, history: ChatMessage[]): GroundingResult {
  const scope = buildScope(normaliseHistory(history, userMessage));

  /* --------------------------- ORDER ID --------------------------- */
  const orderId = resolveSlot('ORDER_ID', userMessage, scope, {
    strict: (text) => {
      const value = extractOrderId(text);
      return value ? { value, source: 'current_message' } : null;
    },
    // A bare "10231" is only read as an order id when we asked for one.
    shorthand: (text) => {
      const value = extractBareOrderId(text);
      return value ? { value, source: 'current_message' } : null;
    },
  });

  /* ---------------------------- ITEM SKU --------------------------- */
  const sku = resolveSlot('ITEM_SKU', userMessage, scope, {
    strict: (text) => {
      const explicit = extractExplicitSku(text);
      if (explicit) return { value: explicit, source: 'current_message' };
      const catalog = resolveProductToSku(text);
      return catalog ? { value: catalog.sku, source: 'catalog' } : null;
    },
    // "SHOE-WHT-02" style tokens only count when we asked for the SKU.
    shorthand: (text) => {
      const value = extractSkuShapedToken(text);
      return value ? { value, source: 'current_message' } : null;
    },
  });

  /* ----------------------------- REASON ---------------------------- */
  const reason = resolveSlot('REASON', userMessage, scope, {
    strict: (text) => {
      const value = extractReason(text);
      return value ? { value, source: 'current_message' } : null;
    },
  });

  const checks: GroundingCheck[] = [
    {
      param: 'ORDER_ID',
      label: 'Order ID',
      present: Boolean(orderId),
      value: orderId?.value,
      source: orderId?.source,
      confidence: orderId?.confidence ?? 0,
    },
    {
      param: 'ITEM_SKU',
      label: 'Item SKU',
      present: Boolean(sku),
      value: sku?.value,
      source: sku?.source,
      confidence: sku?.confidence ?? 0,
    },
    {
      param: 'REASON',
      label: 'Reason',
      present: Boolean(reason),
      value: reason?.value,
      source: reason?.source,
      confidence: reason?.confidence ?? 0,
    },
  ];

  // Preserve the canonical ORDER_ID → ITEM_SKU → REASON ordering.
  const ordered = REQUIRED_PARAMS.map(
    (p) => checks.find((c) => c.param === (p.param as GroundingParam))!,
  );
  const missing = ordered.filter((c) => !c.present);

  return {
    approved: missing.length === 0,
    checks: ordered,
    missing: missing.map((m) => m.label),
    missingParams: missing.map((m) => m.param),
  };
}
