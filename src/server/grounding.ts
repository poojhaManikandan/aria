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

/**
 * Explicitly labelled values still need a small stopword guard: "order
 * status" and "sku is damaged" are prose, not identifiers.
 */
const NON_IDENTIFIER_WORDS = new Set([
  ...ID_STOPWORDS,
  'sku',
  'id',
  'code',
  'number',
  'no',
  'status',
  'info',
  'information',
  'tracking',
  'update',
  'details',
  'history',
  'confirmation',
  'email',
  'refund',
  'return',
  'product',
  'item',
  'order',
  'help',
  'unknown',
  'none',
  'what',
  'which',
  'from',
  'with',
  'has',
  'have',
  'had',
  'arrived',
  'broken',
  'damaged',
  'defective',
  'faulty',
  'cracked',
  'torn',
  'scratched',
  'ripped',
  'malfunction',
  'late',
  'missing',
  'lost',
  'stopped',
  'working',
  'not',
  'wrong',
  'size',
  'color',
  'colour',
  'quality',
  'poor',
]);

/** Extract an order id from a chunk of text. Returns null when ambiguous. */
export function extractOrderId(text: string): string | null {
  const candidates: string[] = [];

  // "order #99482", "order id 99482", "order number: 99482", "order 99482"
  // Customers also call the order reference their "product" or "item" number.
  const explicit =
    /\b(?:orders?|products?|items?|purchases?|invoices?|references?|refs?)\s*(?:id\s*|no\.?\s*|number\s*|#)?\s*[:#]?\s*([a-z0-9][a-z0-9-]{2,})\b/gi;
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
    if (NON_IDENTIFIER_WORDS.has(value.toLowerCase())) continue;

    // Order ids are numeric, alphanumeric-with-digits, hyphenated, or an
    // explicit uppercase reference. Plain lowercase prose is rejected.
    const looksLikeId =
      /\d/.test(value) || value.includes('-') || value === value.toUpperCase();
    if (!looksLikeId) continue;

    return value;
  }

  return null;
}

/** Extract an explicitly stated SKU code, if any. */
export function extractExplicitSku(text: string): string | null {
  const match =
    /\bsku\b(?:[-\s:#]+(?:id|code|number|no\.?|is|of|the))?[-\s:#]*([a-z0-9][a-z0-9-]{2,})\b/i.exec(
      text,
    );
  if (!match) return null;
  const value = match[1].trim().toUpperCase();
  // Accept arbitrary demo codes, but never connector/prose words.
  return NON_IDENTIFIER_WORDS.has(value.toLowerCase()) ? null : value;
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
  const match = /\b(\d{3,})\b/.exec(withoutMoney);
  return match ? match[1] : null;
}

/** Extract a SKU-shaped token, e.g. "SHOE-WHT-02", in any casing. */
export function extractSkuShapedToken(text: string): string | null {
  const match = /\b([A-Za-z]{2,}[A-Za-z0-9]*-[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]{2,})?)\b/.exec(text);
  if (!match) return null;
  // Require at least one digit so hyphenated words can't masquerade as SKUs.
  return /\d/.test(match[1]) ? match[1].toUpperCase() : null;
}

/**
 * Extract a bare SKU answer, e.g. "9024", "TEST" or "SKU 9024", when the agent
 * asked for a SKU. Arbitrary demo data is allowed, including letter-only codes.
 */
export function extractBareSku(text: string): string | null {
  const firstToken = text
    .trim()
    .replace(/^sku[-\s:#]*/i, '')
    .split(/\s+/)[0]
    ?.replace(/[^\w-]/g, '');

  if (!firstToken) return null;
  const value = firstToken.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,}$/.test(value)) return null;
  if (NON_IDENTIFIER_WORDS.has(value.toLowerCase())) return null;
  return value;
}

/** Remove SKU references before looking for a bare order number. */
function stripSkuReferences(text: string): string {
  return text.replace(
    /\bsku\b(?:[-\s:#]+(?:id|code|number|no\.?|is|of|the))?[-\s:#]*[a-z0-9][a-z0-9-]*/gi,
    ' ',
  );
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
 * Does this turn belong to the clarification exchange the agent opened?
 *
 * A reply such as "10231", "the white sneakers" or "the product was shoes"
 * carries almost no linguistic signal, so the 2B classifier alone cannot tell
 * whether it continues a refund request or starts a fresh question. The
 * conversation context can: while the last assistant turn is still asking for
 * missing slots, a reply is part of that exchange unless it clearly switches
 * intent (tracking, pricing, a human, a complaint, …).
 *
 * Being permissive here is essential: free-form answers must never be
 * re-routed as a brand-new request, because that would discard the slots that
 * were already grounded and ask the customer for them all over again.
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

  // A complete new refund request restarts the workflow. Without this check a
  // canned scenario re-run (or a customer restating the issue) could be read as
  // an answer to the previous question and inherit its resolved order/SKU.
  if (isFreshRefundRequest(message, history)) return false;

  // Any other reply continues the open clarification exchange. Grounding will
  // re-evaluate every slot from the accumulated history, and the deterministic
  // clarification copy will ask only for what is still missing.
  return true;
}

/**
 * Does this message start a new refund request while a clarification exchange
 * is still open?
 *
 * A new request has refund/return intent AND does not supply a value for any of
 * the slots the agent is currently waiting on. A reply such as
 * "order 10231, it arrived damaged" carries values and therefore remains part
 * of the exchange; a restatement like "I want a refund for my damaged item
 * please" does not, so its previous slots must not be carried over.
 */
export function isFreshRefundRequest(message: string, history: ChatMessage[]): boolean {
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  const requested = lastAssistant?.requests ?? [];
  if (!requested.length) return false;

  if (!/\b(?:refund|reimburse|reimbursement|money back|return|exchange)\b/i.test(message)) {
    return false;
  }

  for (const param of requested) {
    if (param === 'ORDER_ID') {
      if (extractOrderId(message)) return false;
      if (extractBareOrderId(stripSkuReferences(message))) return false;
    }
    if (param === 'ITEM_SKU') {
      if (extractExplicitSku(message)) return false;
      if (extractSkuShapedToken(message)) return false;
      if (extractBareSku(message)) return false;
    }
    if (param === 'REASON' && extractReason(message)) return false;
  }

  return true;
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
  /** Every user turn in the open clarification exchange (newest first). */
  exchangeTurns(): string[];
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

  const exchangeTurns = (): string[] => {
    if (chain.length === 0) return [];
    // Include the request that opened the exchange as well as every following
    // customer turn. This is how a reason volunteered while the agent was
    // asking for the SKU is recovered from the chat history.
    const start = Math.max(0, chain[0].index - 1);
    const out: string[] = [];
    for (let i = turns.length - 1; i >= start; i -= 1) {
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
    exchangeTurns,
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
  extractors: {
    strict: Extractor;
    shorthand?: Extractor;
    /** Extra user turns to scan for an explicitly stated value. */
    contextTurns?: () => string[];
  },
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
  const currentlyAsked = Boolean(scope.clarification?.requests?.includes(param));

  /* 2 — shorthand answer to the question we are asking right now */
  if (currentlyAsked && extractors.shorthand) {
    const shorthand = extractors.shorthand(currentMessage);
    if (shorthand) {
      return { value: shorthand.value, source: 'current_message', confidence: 0.9 };
    }
  }

  /* 3 — answered after we asked, never before. Only explicit values are
     accepted from context: a bare number could be either an order id or a
     SKU, so context shorthand can silently overwrite the other slot. */
  if (asked >= 0) {
    for (const text of scope.turnsAfter(asked)) {
      const found = extractors.strict(text);
      if (found) return { value: found.value, source: 'chat_context', confidence: 0.86 };
    }
  }

  /* 3b — stated earlier in the open clarification exchange, even when this
     slot was not the one we asked for. Reason is the important case: the
     customer can explain what broke while we are waiting for the SKU, and
     that explanation still belongs in the refund tool payload. */
  if (extractors.contextTurns) {
    for (const text of extractors.contextTurns()) {
      const found = extractors.strict(text) ?? extractors.shorthand?.(text) ?? null;
      if (found) return { value: found.value, source: 'chat_context', confidence: 0.84 };
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
export interface GroundingOptions {
  /**
   * Ignore previous clarification turns. Used when the customer restates a new
   * refund request: values from an earlier exchange must not be resurrected.
   */
  ignoreClarificationContext?: boolean;
}

export function groundParameters(
  userMessage: string,
  history: ChatMessage[],
  options: GroundingOptions = {},
): GroundingResult {
  const scopedHistory = options.ignoreClarificationContext
    ? []
    : normaliseHistory(history, userMessage);
  const scope = buildScope(scopedHistory);

  /* --------------------------- ORDER ID --------------------------- */
  const orderId = resolveSlot('ORDER_ID', userMessage, scope, {
    strict: (text) => {
      const value = extractOrderId(text);
      if (value) return { value, source: 'current_message' };

      // A standalone 4+ digit reference inside a refund/defect message is the
      // order number, even when the customer describes it as "my product
      // 12345" rather than "order #12345". Money amounts are stripped first.
      const refundContext = /\b(?:refund|return|reimburse|broken|damaged|defective|faulty)\b/i.test(
        text,
      );
      if (refundContext) {
        const bare = extractBareOrderId(stripSkuReferences(text));
        if (bare) return { value: bare, source: 'current_message' };
      }

      return null;
    },
    // A bare "10231" is only read as an order id when we asked for one.
    shorthand: (text) => {
      const value = extractBareOrderId(stripSkuReferences(text));
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
    // "SHOE-WHT-02" style tokens, or a plain demo code such as "9024", only
    // count when we asked for the SKU. When Order ID and SKU are both still
    // open, a bare number is treated as the order id the agent asked for first.
    shorthand: (text) => {
      const shaped = extractSkuShapedToken(text);
      if (shaped) return { value: shaped, source: 'current_message' };

      const orderAlsoAsked = Boolean(scope.clarification?.requests?.includes('ORDER_ID'));
      if (orderAlsoAsked) return null;

      const bare = extractBareSku(text);
      return bare ? { value: bare, source: 'current_message' } : null;
    },
  });

  /* ----------------------------- REASON ---------------------------- */
  const reason = resolveSlot('REASON', userMessage, scope, {
    strict: (text) => {
      const value = extractReason(text);
      return value ? { value, source: 'current_message' } : null;
    },
    // The reason is often volunteered before/while we ask for another slot.
    contextTurns: () => scope.exchangeTurns(),
  });

  const checks: GroundingCheck[] = [
    {
      param: 'ORDER_ID',
      label: 'Order ID',
      present: Boolean(orderId),
      value: orderId?.value,
      source: orderId?.source,
      confidence: orderId?.confidence ?? 0,
      status: orderId ? 'candidate' : 'missing',
    },
    {
      param: 'ITEM_SKU',
      label: 'Item SKU',
      present: Boolean(sku),
      value: sku?.value,
      source: sku?.source,
      confidence: sku?.confidence ?? 0,
      status: sku ? 'candidate' : 'missing',
    },
    {
      param: 'REASON',
      label: 'Reason',
      present: Boolean(reason),
      value: reason?.value,
      source: reason?.source,
      confidence: reason?.confidence ?? 0,
      status: reason ? 'candidate' : 'missing',
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
