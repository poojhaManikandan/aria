/**
 * End-to-end verification of the three-layer pipeline.
 * Run with:  npx tsx scripts/verify-pipeline.ts
 */
import { processTurn } from '../src/server/pipeline';
import { MAIN_AGENT_FALLBACK_MESSAGE, runMainAgent } from '../src/server/main-agent';
import { SCENARIOS } from '../src/lib/constants';
import type { ChatMessage, GroundingParam, GroundingResult } from '../src/lib/types';

const EXPECTED: Record<string, { label: string; guardrail: string; mainAgent: boolean; toolStatus: string }> = {
  A: { label: 'SAFE_INFO_REQUEST', guardrail: 'GREEN', mainAgent: true, toolStatus: 'executed' },
  B: { label: 'POTENTIAL_FRAUD_ABUSE', guardrail: 'RED', mainAgent: false, toolStatus: 'frozen' },
  C: { label: 'VALID_RETURN_REQUEST', guardrail: 'AMBER', mainAgent: false, toolStatus: 'skipped' },
};

let failures = 0;

async function main() {
  for (const scenario of SCENARIOS) {
    const { trace, events } = await processTurn({ message: scenario.message, history: [] });
    const expected = EXPECTED[scenario.key];

    const tool = trace.tools[0];
    const checks: Array<[string, boolean]> = [
      ['label', trace.decision.label === expected.label],
      ['guardrail', trace.guardrail === expected.guardrail],
      ['mainAgentInvoked', trace.mainAgentInvoked === expected.mainAgent],
      ['toolStatus', tool?.status === expected.toolStatus],
    ];

    const ok = checks.every(([, pass]) => pass);
    if (!ok) failures += 1;

    console.log(`${ok ? 'PASS' : 'FAIL'}  Scenario ${scenario.key} — ${scenario.title}`);
    console.log(`      label=${trace.decision.label} conf=${trace.decision.confidence}`);
    console.log(`      guardrail=${trace.guardrail} action=${trace.action} mainAgent=${trace.mainAgentInvoked}`);
    console.log(
      `      grounding: ${trace.grounding.checks
        .map((c) => `${c.label}=${c.present ? c.value : 'MISSING'}`)
        .join(' | ')}`,
    );
    console.log(
      `      tools: ${trace.tools.map((t) => `${t.name}[${t.status}]`).join(', ') || 'none'}`,
    );
    console.log(
      `      latency: decider=${trace.decision.latencyMs}ms main=${trace.mainAgentLatencyMs}ms total=${trace.totalLatencyMs}ms`,
    );
    console.log(
      `      cost: spent=$${trace.costSpentUsd.toFixed(4)} saved=$${trace.costSavedUsd.toFixed(4)} (${(trace.costSavedPct * 100).toFixed(1)}%)`,
    );
    console.log(`      exposure prevented: $${trace.preventedExposureUsd}`);
    console.log(`      events: ${events.length}`);
    console.log(`      reply: ${trace.assistantMessage.replace(/\n/g, ' ').slice(0, 150)}...`);
    console.log('');
  }

  console.log('');
  console.log('── Conversation continuity (regression) ──────────────────────');
  await continuityChecks();

  console.log('');
  console.log('── Layer 3 resilience (regression) ───────────────────────────');
  await layer3ResilienceChecks();

  console.log(failures === 0 ? '✅ Pipeline verified.' : `❌ ${failures} scenario(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

let clock = Date.now();
function msg(
  role: ChatMessage['role'],
  content: string,
  requests?: ChatMessage['requests'],
  resolved?: ChatMessage['resolved'],
): ChatMessage {
  return { id: `${role}-${clock++}`, role, content, ts: clock, requests, resolved };
}

/** Turn helper that mirrors what the client stores after each response. */
async function turn(message: string, history: ChatMessage[]) {
  const result = await processTurn({ message, history });
  const resolved: Partial<Record<GroundingParam, string>> = {};
  for (const check of result.trace.grounding.checks) {
    if (check.present && check.value) resolved[check.param] = check.value;
  }
  const assistant = msg(
    'assistant',
    result.trace.assistantMessage,
    result.trace.action === 'CLARIFY_GROUNDING'
      ? result.trace.grounding.missingParams
      : undefined,
    result.trace.action === 'CLARIFY_GROUNDING' ? resolved : undefined,
  );
  return { ...result, history: [...history, msg('user', message), assistant] };
}

/**
 * The bug this guards against: after a safe order-status turn, clicking
 * Scenario C used to inherit #99482 + "blue shoes" from chat history and
 * execute a refund nobody asked for.
 */
async function continuityChecks() {
  const SAFE = SCENARIOS.find((s) => s.key === 'A')!;
  const UNGROUNDED = SCENARIOS.find((s) => s.key === 'C')!;
  const FRAUD = SCENARIOS.find((s) => s.key === 'B')!;

  // 1) Safe turn first, then an ungrounded refund request.
  const afterSafe = await turn(SAFE.message, []);
  const c1 = await turn(UNGROUNDED.message, afterSafe.history);
  report('C after A cannot borrow order/SKU from context', [
    ['guardrail AMBER', c1.trace.guardrail === 'AMBER'],
    ['refund NOT executed', !c1.trace.tools.some((t) => t.status === 'executed')],
    ['asks for Order ID', /order id/i.test(c1.trace.assistantMessage)],
    ['uses requested copy', /need a bit more information first/i.test(c1.trace.assistantMessage)],
    ['order still missing', c1.trace.grounding.checks.find((c) => c.param === 'ORDER_ID')?.present === false],
    [
      'exact clarification copy',
      c1.trace.assistantMessage.startsWith(
        'I can certainly help you with a refund for your damaged item. However, I need a bit more information first. Could you please provide your Order ID?',
      ),
    ],
  ]);

  // 2) Fraud turn first, then the same ungrounded request.
  const afterFraud = await turn(FRAUD.message, []);
  const c2 = await turn(UNGROUNDED.message, afterFraud.history);
  report('C after B cannot borrow order #0000 from context', [
    ['guardrail AMBER', c2.trace.guardrail === 'AMBER'],
    ['refund NOT executed', !c2.trace.tools.some((t) => t.status === 'executed')],
  ]);

  // 3) Clarification reply DOES ground, because the agent asked for it.
  const followUp = await turn(
    'It is order #10231 — the white sneakers arrived damaged.',
    c1.history,
  );
  const refund = followUp.trace.tools.find((t) => t.name === 'execute_refund');
  report('clarification reply grounds and refunds the right order', [
    ['guardrail GREEN', followUp.trace.guardrail === 'GREEN'],
    ['refund executed', refund?.status === 'executed'],
    ['order #10231', /#?10231/.test(JSON.stringify(refund?.args ?? {}))],
  ]);

  // 4) THE REPORTED BUG — clicking Scenario C again (or after a safe order
  //    lookup) must never resurrect #99482 and process a refund.
  const c3 = await turn(UNGROUNDED.message, c1.history);
  report('C clicked again never reuses the earlier order id', [
    ['guardrail AMBER', c3.trace.guardrail === 'AMBER'],
    ['action CLARIFY_GROUNDING', c3.trace.action === 'CLARIFY_GROUNDING'],
    ['refund NOT executed', !c3.trace.tools.some((t) => t.status === 'executed')],
    ['no tool executed at all', c3.trace.tools.every((t) => t.status !== 'executed')],
    ['order still missing', c3.trace.grounding.checks.find((c) => c.param === 'ORDER_ID')?.present === false],
    ['sku still missing', c3.trace.grounding.checks.find((c) => c.param === 'ITEM_SKU')?.present === false],
  ]);

  const c4 = await turn(UNGROUNDED.message, c3.history);
  report('C clicked twice in a row never refunds', [
    ['guardrail AMBER', c4.trace.guardrail === 'AMBER'],
    ['refund NOT executed', !c4.trace.tools.some((t) => t.status === 'executed')],
  ]);

  // 4b) A safe lookup, then a fraud attempt, then the ungrounded refund.
  const mixed = await turn(SAFE.message, []);
  const mixed2 = await turn(FRAUD.message, mixed.history);
  const mixed3 = await turn(UNGROUNDED.message, mixed2.history);
  report('C after A and B never refunds', [
    ['guardrail AMBER', mixed3.trace.guardrail === 'AMBER'],
    ['action CLARIFY_GROUNDING', mixed3.trace.action === 'CLARIFY_GROUNDING'],
    ['refund NOT executed', !mixed3.trace.tools.some((t) => t.status === 'executed')],
    ['no order borrowed', mixed3.trace.grounding.checks.find((c) => c.param === 'ORDER_ID')?.present === false],
  ]);

  // 5) A progressive clarification (one slot per turn) still completes.
  const step1 = await turn(UNGROUNDED.message, []);
  const step2 = await turn('10231', step1.history);
  const step3 = await turn('the white sneakers', step2.history);
  const progressive = step3.trace.tools.find((t) => t.name === 'execute_refund');
  report('progressive clarification completes the refund', [
    ['order id captured', step2.trace.grounding.checks.find((c) => c.param === 'ORDER_ID')?.value === '10231'],
    ['sku still missing after step 2', step2.trace.grounding.checks.find((c) => c.param === 'ITEM_SKU')?.present === false],
    ['guardrail GREEN', step3.trace.guardrail === 'GREEN'],
    ['refund executed', progressive?.status === 'executed'],
    ['right sku', /SHOE-WHT-02/.test(JSON.stringify(progressive?.args ?? {}))],
    ['reason carried over', /damaged/.test(JSON.stringify(progressive?.args ?? {}))],
  ]);

  // 5b) A numeric-only SKU reply must complete the refund without being
  //     mistaken for a new order id.
  const numericStep1 = await turn('refund for my damaged product', []);
  const numericStep2 = await turn('46896', numericStep1.history);
  const numericStep3 = await turn('9024', numericStep2.history);
  const numericRefund = numericStep3.trace.tools.find((t) => t.name === 'execute_refund');
  report('numeric-only SKU reply keeps the order id', [
    ['order id captured', numericStep2.trace.grounding.checks.find((c) => c.param === 'ORDER_ID')?.value === '46896'],
    ['sku still missing after order reply', numericStep2.trace.grounding.checks.find((c) => c.param === 'ITEM_SKU')?.present === false],
    ['guardrail GREEN', numericStep3.trace.guardrail === 'GREEN'],
    ['order id preserved', /46896/.test(JSON.stringify(numericRefund?.args ?? {}))],
    ['numeric sku captured', /9024/.test(JSON.stringify(numericRefund?.args ?? {}))],
    ['refund executed', numericRefund?.status === 'executed'],
  ]);

  // 6) A bare order number must not be escalated to a human — it is the
  //    answer to the question the agent just asked.
  report('bare order-number reply continues the refund flow', [
    ['action CLARIFY_GROUNDING', step2.trace.action === 'CLARIFY_GROUNDING'],
    ['not escalated', step2.trace.action !== 'ESCALATED_TO_HUMAN'],
  ]);

  // 7) Arbitrary demo data: the ledger only seeds a handful of orders, but
  //    the agent must still handle any order id / SKU the tester supplies.
  const dummyStart = await turn('i need refund for my product 12345 as it was broken', []);
  const dummyDone = await turn('the product was shoes', dummyStart.history);
  const dummyRefund = dummyDone.trace.tools.find((t) => t.name === 'execute_refund');
  report('dummy order id plus product words completes the refund', [
    ['dummy order accepted', /#?12345/.test(JSON.stringify(dummyRefund?.args ?? {}))],
    ['product word resolved to a SKU', /SHOE-BLU-01/.test(JSON.stringify(dummyRefund?.args ?? {}))],
    ['refund executed', dummyRefund?.status === 'executed'],
  ]);

  const arbitrary = await turn('refund order 55555 sku XYZ-999 because defective', []);
  const arbitraryRefund = arbitrary.trace.tools.find((t) => t.name === 'execute_refund');
  report('arbitrary order id and SKU are accepted as demo data', [
    ['arbitrary order accepted', /55555/.test(JSON.stringify(arbitraryRefund?.args ?? {}))],
    ['arbitrary SKU accepted', /XYZ-999/.test(JSON.stringify(arbitraryRefund?.args ?? {}))],
    ['refund executed', arbitraryRefund?.status === 'executed'],
  ]);

  const anyValues = await turn('refund order 123 sku abc because damaged', []);
  const anyValuesRefund = anyValues.trace.tools.find((t) => t.name === 'execute_refund');
  report('short numeric order id and letter-only SKU are accepted', [
    ['short order accepted', /123/.test(JSON.stringify(anyValuesRefund?.args ?? {}))],
    ['letter SKU accepted', /ABC/.test(JSON.stringify(anyValuesRefund?.args ?? {}))],
    ['refund executed', anyValuesRefund?.status === 'executed'],
  ]);

  // 8) Unrecognised chat should get a helpful fallback, not a human ticket.
  const smallTalk = await turn('hello, what can you do?', []);
  report('general chat gets a helpful fallback', [
    ['not escalated', smallTalk.trace.action !== 'ESCALATED_TO_HUMAN'],
    ['explains capabilities', /order tracking/i.test(smallTalk.trace.assistantMessage)],
  ]);
}

async function layer3ResilienceChecks() {
  const grounding: GroundingResult = {
    approved: true,
    checks: [
      {
        param: 'ORDER_ID',
        label: 'Order ID',
        present: true,
        value: '99482',
        source: 'current_message',
        confidence: 1,
      },
      {
        param: 'ITEM_SKU',
        label: 'Item SKU',
        present: true,
        value: 'SHOE-BLU-01',
        source: 'current_message',
        confidence: 1,
      },
      {
        param: 'REASON',
        label: 'Reason',
        present: true,
        value: 'damaged',
        source: 'current_message',
        confidence: 1,
      },
    ],
    missing: [],
    missingParams: [],
  };

  const failedEvents: Array<{ stage: string }> = [];
  const failedRefund = await runMainAgent({
    label: 'VALID_RETURN_REQUEST',
    userMessage: 'refund order 99482 sku SHOE-BLU-01 because damaged',
    grounding,
    authorisation: null,
    emit: (event) => {
      failedEvents.push(event);
    },
  });
  const failedTool = failedRefund.tools.find((tool) => tool.name === 'execute_refund');
  report('execute_refund failure returns a graceful reply', [
    ['tool marked failed', failedTool?.status === 'failed'],
    ['no refund executed', !failedRefund.tools.some((tool) => tool.status === 'executed')],
    ['reply says no money moved', /no money has moved/i.test(failedRefund.message)],
    ['tool-error telemetry emitted', failedEvents.some((event) => event.stage === 'TOOL_ERROR')],
  ]);

  const fallbackEvents: Array<{ stage: string }> = [];
  const broken = await runMainAgent({
    label: 'VALID_RETURN_REQUEST',
    userMessage: 'refund order 99482 sku SHOE-BLU-01 because damaged',
    grounding: null as unknown as GroundingResult,
    authorisation: 'GROUNDING_APPROVED::v1',
    emit: (event) => {
      fallbackEvents.push(event);
    },
  });
  report('unexpected Layer 3 failure is caught', [
    ['fallback message returned', broken.message === MAIN_AGENT_FALLBACK_MESSAGE],
    ['no tools returned', broken.tools.length === 0],
    ['zero model cost', broken.costUsd === 0],
    ['fallback telemetry emitted', fallbackEvents.some((event) => event.stage === 'AGENT_FALLBACK')],
  ]);
}

function report(title: string, checks: Array<[string, boolean]>) {
  const ok = checks.every(([, pass]) => pass);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}`);
  for (const [name] of checks.filter(([, p]) => !p)) {
    console.log(`      ✗ ${name}`);
  }
}

main();
