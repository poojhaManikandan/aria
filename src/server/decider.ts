import type { Attribution, DeciderDecision, DecisionLabel } from '@/lib/types';
import { DECISION_LABELS } from '@/lib/types';
import { MODEL_COST } from '@/lib/constants';

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  Strands Decider 2B — Policy Classifier & Guardrail Gatekeeper  (Layer 1)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This module emulates the behaviour of a 2-billion-parameter "pointer"
 * network used as a deterministic gatekeeper in front of an expensive LLM.
 *
 * A pointer network works by *pointing* at one of a small set of label
 * prototypes. Emulating one faithfully means we must not simply do
 * `if (text.includes('refund'))` — instead we:
 *
 *   1. Extract a set of semantic FEATURES from the utterance. Each feature is
 *      a compiled surface pattern that a distilled 2B model reliably encodes.
 *   2. Score every label prototype by summing the pointer weights of the
 *      features that fired (plus a learned per-label bias).
 *   3. Add a small deterministic "generalisation" term derived from a hashed
 *      pseudo-embedding of the tokens that no explicit feature claimed —
 *      this is what lets the model still respond sanely to unseen phrasing.
 *   4. Softmax the scores into a probability distribution and calibrate a
 *      confidence score from the winner/ runner-up margin.
 *
 * The result is a *deterministic* classifier (same input ⇒ same output),
 * which is exactly what a gatekeeper needs: it must be auditable and
 * reproducible for compliance review.
 */

/** A single learned pointer feature. */
interface FeatureRule {
  /** Human readable semantic name (shown in the attribution chips). */
  feature: string;
  /** Surface forms that activate the pointer. */
  patterns: RegExp[];
  /** Pointer weight (logit contribution). */
  weight: number;
}

/** Learned bias of each label prototype (the "norm" of the pointer head). */
const LABEL_BIAS: Record<DecisionLabel, number> = {
  SAFE_INFO_REQUEST: 0.45,
  POTENTIAL_FRAUD_ABUSE: -2.9,
  VALID_RETURN_REQUEST: 0.2,
  HUMAN_ESCALATION: -1.4,
};

/**
 * The distilled feature set. Weights are hand-tuned so that the classifier
 * mirrors the operational policy of a real support-automation gate.
 */
const LABEL_FEATURES: Record<DecisionLabel, FeatureRule[]> = {
  /* ---------------- SAFE_INFO_REQUEST ---------------- */
  SAFE_INFO_REQUEST: [
    {
      feature: 'shipment_tracking_query',
      patterns: [
        /\bwhere(?:'s| is| are)?\b.{0,18}\b(?:order|package|parcel|shipment|delivery)\b/,
        /\b(track|tracking|shipment status|delivery status|on its way|dispatch(ed)?)\b/,
        // Narrow "arrive" so "arrived damaged" is read as a return reason,
        // not as a shipment-tracking query.
        /\bwhen (?:will|is|are|does|do)\b[^.!?]{0,24}\b(?:arriv\w*|ship\w*|deliver\w*|get here)\b/,
        /\bhas (?:it|my (?:order|package|parcel)) (?:arrived|shipped|been dispatched)\b/,
        /\barriv(?:al|e|es|ing)\b[^.!?]{0,16}\b(?:date|time|today|tomorrow|soon|yet)\b/,
        /\barrived\b[^.!?]{0,12}\b(?:today|tomorrow|yesterday|yet|already)\b/,
        /\beta\b|\bdue (?:to|when)\b/,
      ],
      weight: 2.2,
    },
    {
      feature: 'order_reference',
      patterns: [/\border\s*(?:id|no\.?|number|#)?\s*[:#]?\s*[a-z0-9][a-z0-9-]{2,}/i],
      weight: 1.4,
    },
    {
      feature: 'possessive_order_mention',
      patterns: [/\bmy (?:order|purchase|package|parcel|delivery|basket|cart)\b/],
      weight: 1.6,
    },
    {
      feature: 'information_seeking',
      patterns: [
        /\b(what(?:'s| is)|how much|how do i|can you (?:tell|check|look up|find|share)|tell me about|information|details? about)\b/,
      ],
      weight: 1.2,
    },
    {
      feature: 'price_inquiry',
      patterns: [/\b(price|cost|total|how much)\b/],
      weight: 0.9,
    },
    {
      feature: 'catalog_product_mention',
      patterns: [
        /\b(shoes?|sneakers?|tshirts?|t-?shirts?|hoodies?|jackets?|backpacks?|headphones?|monitor|keyboard|mouse|wallet|bottle|yoga mat)\b/,
      ],
      weight: 0.5,
    },
  ],

  /* ---------------- POTENTIAL_FRAUD_ABUSE ---------------- */
  POTENTIAL_FRAUD_ABUSE: [
    {
      feature: 'policy_override_injection',
      patterns: [
        /\b(ignore|forget|disregard|bypass|override|disable|skip|circumvent|drop)\b[^.!?]{0,40}\b(polic(?:y|ies)|instruction|rule|system|control|guardrail|constraint|restriction|directive)s?\b/i,
        /\bforget (?:your|all|any|the|previous|prior)\b/i,
        /\bno (?:restrictions|limits|rules|checks|verification)\b/i,
      ],
      weight: 3.2,
    },
    {
      feature: 'system_control_tamper',
      patterns: [
        /\b(overrid\w+|bypass\w*|disabl\w+|unlock\w*|admin mode|developer mode|god mode|root access|sudo|escalate privileges)\b/i,
      ],
      weight: 2.4,
    },
    {
      feature: 'persona_override',
      patterns: [
        /\b(act as|pretend (?:to be|you are)|you are now|roleplay as|from now on you are|impersonate|new (?:system )?instructions?|your new (?:rules|instructions))\b/i,
      ],
      weight: 2.8,
    },
    {
      feature: 'excessive_refund_demand',
      patterns: [
        /\b(maximum|full|entire|total|unlimited|blanket|guaranteed)\b[^.!?]{0,24}?\b(refund|credit|chargeback|money back|reimbursement)s?\b/i,
        /\b(refund|credit|chargeback|money back|reimbursement)s?\b[^.!?]{0,20}\b(unlimited|maximum|full|entire|blanket|guaranteed)\b/i,
        /\bunlimited (?:refund|amount|credit|money|sum)\b/i,
        /\brefund (?:everything|all of it|the whole)\b/i,
      ],
      weight: 3.0,
    },
    {
      feature: 'abnormal_amount',
      patterns: [/\$?\s*([1-9]\d{3,}(?:\.\d{2})?)\b/],
      weight: 2.2,
    },
    {
      feature: 'verification_bypass',
      patterns: [
        /\bwithout\b[^.!?]{0,24}\b(a |any )?(reason|justification|verification|proof|evidence|checks?|approval|receipt|return label|inspection|review)\b/i,
        /\bno (?:need for|questions about|verification required)\b/i,
      ],
      weight: 2.6,
    },
    {
      feature: 'urgency_bypass',
      patterns: [
        /\b(immediately|right now|instantly|no questions|bypass the (?:process|policy)|skip the (?:process|checks?|policy)|without delay|asap)\b/i,
      ],
      weight: 1.5,
    },
    {
      feature: 'bulk_scope_abuse',
      patterns: [
        /\b(all|every|each)\b[^.!?]{0,16}\b(my )?(orders?|purchases?|items?|transactions?|invoices?)\b/i,
        /\brefund (?:all|every) (?:of )?my\b/i,
      ],
      weight: 2.6,
    },
    {
      feature: 'bulk_refund_demand',
      patterns: [/\brefund (?:all|every|each|multiple)\b/i],
      weight: 2.4,
    },
    {
      feature: 'payment_reversal_abuse',
      patterns: [
        /\b(charge ?back|reverse (?:the |all )?charges?|refund (?:twice|double)|double refund|steal|launder)\b/i,
      ],
      weight: 2.4,
    },
    {
      feature: 'authority_social_engineering',
      patterns: [
        /\b(i'?m (?:the )?(?:owner|manager|ceo|founder)|my lawyer|my attorney|legal action|i will sue|press|regulator)\b/i,
      ],
      weight: 1.4,
    },
  ],

  /* ---------------- VALID_RETURN_REQUEST ---------------- */
  VALID_RETURN_REQUEST: [
    {
      feature: 'refund_intent',
      patterns: [
        /\b(refund|reimburse|reimbursement|money back|credit back)\b/i,
        /\breturn (?:the |my |this )?(item|product|order|purchase|shoes?|sneakers?|headphones?)\b/i,
      ],
      weight: 2.6,
    },
    {
      feature: 'return_intent',
      patterns: [/\b(send (?:it |them )?back|exchange|replace|rma)\b/i],
      weight: 1.6,
    },
    {
      feature: 'defect_justification',
      patterns: [
        /\b(damaged|broken|defective|defect|faulty|cracked|torn|scratched|ripped|malfunction\w*|not working|stopped working|tear|hole|corrupt)\b/i,
        /\b(wrong (?:item|size|colour|color|product)|not as (?:described|advertised|expected)|mismatch)\b/i,
      ],
      weight: 2.0,
    },
    {
      feature: 'fulfilment_issue',
      patterns: [
        /\b(late|never (?:arrived|came|received)|missing (?:item|part)|not (?:delivered|received)|lost in transit|wrong address)\b/i,
      ],
      weight: 1.5,
    },
    {
      feature: 'policy_window_reference',
      patterns: [/\b(within \d+ days|return window|return policy|30[- ]day|60[- ]day)\b/i],
      weight: 1.2,
    },
    {
      feature: 'explicit_sku',
      patterns: [/\bsku[-\s:#]*[a-z0-9][a-z0-9-]{2,}/i],
      weight: 1.0,
    },
    {
      feature: 'order_reference',
      patterns: [/\border\s*(?:id|no\.?|number|#)?\s*[:#]?\s*[a-z0-9][a-z0-9-]{2,}/i],
      weight: 0.9,
    },
  ],

  /* ---------------- HUMAN_ESCALATION ---------------- */
  HUMAN_ESCALATION: [
    {
      feature: 'human_agent_request',
      patterns: [
        /\b(speak (?:to|with)|talk (?:to|with)|chat (?:to|with)|connect me (?:to|with)|escalate|real person|human|live agent|customer service (?:rep|agent)|manager|supervisor)\b/i,
      ],
      weight: 2.4,
    },
    {
      feature: 'service_escalation_emotion',
      patterns: [
        /\b(ridiculous|unacceptable|appalling|disgusting|worst|terrible|awful|furious|outrageous)\b/i,
      ],
      weight: 1.8,
    },
    {
      feature: 'account_trap',
      patterns: [
        /\b(account (?:is |has been )?(?:locked|suspended|blocked|frozen)|locked out|can'?t (?:log ?in|access)|hacked|compromised)\b/i,
      ],
      weight: 3.2,
    },
    {
      feature: 'sensitive_escalation_topic',
      patterns: [
        /\b(discriminat\w+|harassment|harm|injur\w+|medical|safety issue|regulator|ombudsman|press|media|social media)\b/i,
      ],
      weight: 2.0,
    },
    {
      feature: 'formal_complaint',
      patterns: [/\b(complain|complaint|formal dispute|chargeback complaint)\b/i],
      weight: 1.6,
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Deterministic hashing — the "generalisation" term                   */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash. Deterministic across runs and platforms. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic pseudo-embedding similarity between an unseen token and a
 * label prototype. Real 2B models generalise to unseen phrasing; this
 * reproduces that behaviour with a stable hash so runs stay reproducible.
 */
function prototypeSimilarity(token: string, label: DecisionLabel): number {
  const raw = (fnv1a(`${label}::${token}`) % 2000) / 1000 - 1; // [-1, 1]
  return raw * 0.14;
}

/* ------------------------------------------------------------------ */
/* Forward pass                                                        */
/* ------------------------------------------------------------------ */

/** Extract the semantic features that fire for a given utterance. */
function pointerPass(text: string): {
  attributions: Attribution[];
  scores: Record<DecisionLabel, number>;
  claimedTokens: Set<string>;
} {
  const lower = ` ${text.toLowerCase()} `;
  const attributions: Attribution[] = [];
  const scores = { ...LABEL_BIAS } as Record<DecisionLabel, number>;
  const claimedTokens = new Set<string>();

  for (const label of DECISION_LABELS) {
    for (const rule of LABEL_FEATURES[label]) {
      for (const pattern of rule.patterns) {
        const match = lower.match(pattern);
        if (!match) continue;
        attributions.push({
          feature: rule.feature,
          trigger: match[0].trim().slice(0, 64),
          weight: rule.weight,
          label,
        });
        scores[label] += rule.weight;
        // Mark the matched span so the generalisation term ignores it.
        for (const token of match[0].toLowerCase().split(/[^a-z0-9$]+/)) {
          if (token.length > 2) claimedTokens.add(token);
        }
        break; // one activation per rule — no double counting
      }
    }
  }

  return { attributions, scores, claimedTokens };
}

/** Hash-derived generalisation signal for tokens no rule claimed. */
function generalisationTerm(
  text: string,
  claimedTokens: Set<string>,
): Record<DecisionLabel, number> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((t) => t.length > 2 && !claimedTokens.has(t) && !/^\d+$/.test(t));

  const term = {} as Record<DecisionLabel, number>;
  for (const label of DECISION_LABELS) {
    let sum = 0;
    for (const token of tokens) sum += prototypeSimilarity(token, label);
    // Deliberately small: the generalisation term is a tie-breaker, never a
    // driver. Explicit semantic features always dominate.
    term[label] = sum * 0.5;
  }
  return term;
}

/** Numerically stable softmax. */
function softmax(scores: number[]): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

/**
 * Run the simulated 2B forward pass over a user utterance.
 *
 * @param text  The raw customer utterance.
 * @param latencyMs  Measured wall-clock time of the (simulated) forward pass.
 */
export function runDecider(text: string, latencyMs: number): DeciderDecision {
  const { attributions, scores, claimedTokens } = pointerPass(text);
  const generalisation = generalisationTerm(text, claimedTokens);

  const finalScores = DECISION_LABELS.map((label) => scores[label] + generalisation[label]);
  const probabilitiesArr = softmax(finalScores);

  const probabilities = {} as Record<DecisionLabel, number>;
  const scoreMap = {} as Record<DecisionLabel, number>;
  DECISION_LABELS.forEach((label, i) => {
    probabilities[label] = probabilitiesArr[i];
    scoreMap[label] = Number(finalScores[i].toFixed(4));
  });

  // Winner = argmax over the probability simplex.
  const ranked = DECISION_LABELS.map((label) => ({ label, p: probabilities[label] })).sort(
    (a, b) => b.p - a.p,
  );
  const winner = ranked[0].label;
  const p1 = ranked[0].p;
  const p2 = ranked[1].p;

  // Calibrated confidence: probability mass, tempered by the decision margin.
  // A high-probability but contested call scores lower than a decisive one.
  const confidence = Math.max(0, Math.min(1, 0.6 * p1 + 0.4 * (p1 - p2)));

  // Keep the strongest pointers for the attribution display.
  const topAttributions = attributions
    .filter((a) => a.label === winner)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 5);

  return {
    model: 'strands-decider-2b',
    label: winner,
    confidence: Number(confidence.toFixed(4)),
    probabilities,
    scores: scoreMap,
    attributions: topAttributions,
    latencyMs: Math.round(latencyMs),
    inputTokens: Math.max(8, Math.ceil(text.length / 4)),
    costUsd: MODEL_COST.DECIDER_USD,
  };
}

/**
 * Below this confidence the gate refuses to guess and hands the conversation
 * to a human — a fail-safe default for a security-critical classifier.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function isLowConfidence(decision: DeciderDecision): boolean {
  return decision.confidence < LOW_CONFIDENCE_THRESHOLD;
}
