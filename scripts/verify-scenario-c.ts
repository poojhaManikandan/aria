/**
 * Acceptance checks for the Scenario C clarification bug and the client-side
 * isolation/duplicate-submission guards.
 *
 * Run with:  npx tsx scripts/verify-scenario-c.ts
 */
import { processTurn } from '../src/server/pipeline';
import { SCENARIOS } from '../src/lib/constants';
import { createTurnGate } from '../src/lib/turn-gate';
import type {
  ChatMessage,
  GroundingParam,
  PipelineTrace,
  TelemetryEvent,
} from '../src/lib/types';

const SCENARIO_A = SCENARIOS.find((scenario) => scenario.key === 'A')!;
const SCENARIO_B = SCENARIOS.find((scenario) => scenario.key === 'B')!;
const SCENARIO_C = SCENARIOS.find((scenario) => scenario.key === 'C')!;

let failures = 0;
let clock = Date.now();

function msg(
  role: ChatMessage['role'],
  content: string,
  requests?: ChatMessage['requests'],
  resolved?: ChatMessage['resolved'],
): ChatMessage {
  return { id: `${role}-${clock++}`, role, content, ts: clock, requests, resolved };
}

async function turn(message: string, history: ChatMessage[], sessionId?: string) {
  const result = await processTurn({ message, history, sessionId });
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

function report(title: string, checks: Array<[string, boolean]>) {
  const ok = checks.every(([, pass]) => pass);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}`);
  for (const [name] of checks.filter(([, pass]) => !pass)) {
    console.log(`      ? ${name}`);
  }
}

function checkValue(trace: PipelineTrace, param: GroundingParam) {
  return trace.grounding.checks.find((check) => check.param === param);
}

function refundArgs(trace: PipelineTrace): Record<string, unknown> {
  return (trace.tools.find((tool) => tool.name === 'execute_refund')?.args ??
    {}) as Record<string, unknown>;
}

function stageData(events: TelemetryEvent[], stage: string) {
  return events.find((event) => event.stage === stage)?.data ?? {};
}

async function scenarioCFirstTurn() {
  const c1 = await turn(SCENARIO_C.message, []);

  report('C asks for missing order + SKU and never invokes Layer 3', [
    ['action CLARIFY_GROUNDING', c1.trace.action === 'CLARIFY_GROUNDING'],
    ['workflow AWAITING_CLARIFICATION', c1.trace.workflow.state === 'AWAITING_CLARIFICATION'],
    ['attempt 1', c1.trace.workflow.clarification.attempt === 1],
    ['Order ID missing', checkValue(c1.trace, 'ORDER_ID')?.present === false],
    ['Item SKU missing', checkValue(c1.trace, 'ITEM_SKU')?.present === false],
    ['both requested', c1.trace.grounding.missingParams.length === 2],
    ['refund skipped', refundArgs(c1.trace).order_id == null],
    ['no tool executed', c1.trace.tools.every((tool) => tool.status !== 'executed')],
    ['Layer 3 not invoked', !c1.trace.mainAgentInvoked],
  ]);

  return c1;
}

async function exactBothSlots(c1: Awaited<ReturnType<typeof turn>>) {
  const c2 = await turn('13235 and sku is 3556', c1.history);
  const args = refundArgs(c2.trace);

  report('one reply with order + SKU proceeds without re-asking', [
    ['action PROCEED_TO_MAIN_AGENT', c2.trace.action === 'PROCEED_TO_MAIN_AGENT'],
    ['workflow EXECUTED', c2.trace.workflow.state === 'EXECUTED'],
    ['Order ID validated', checkValue(c2.trace, 'ORDER_ID')?.status === 'validated'],
    ['Item SKU validated', checkValue(c2.trace, 'ITEM_SKU')?.status === 'validated'],
    ['order 13235', args.order_id === '13235'],
    ['sku 3556', args.sku === '3556'],
    ['refund executed', c2.trace.tools.find((tool) => tool.name === 'execute_refund')?.status === 'executed'],
    ['reply does not ask for SKU again', !/still need|please provide|could you please provide/i.test(c2.trace.assistantMessage)],
  ]);
}

async function separateSlots() {
  const c1 = await turn(SCENARIO_C.message, []);
  const orderTurn = await turn('order #10231', c1.history);
  const skuTurn = await turn('the white sneakers', orderTurn.history);
  const args = refundArgs(skuTurn.trace);

  report('separate order then SKU replies preserve and merge slots', [
    ['order captured', checkValue(orderTurn.trace, 'ORDER_ID')?.value === '10231'],
    ['only SKU still missing', orderTurn.trace.grounding.missingParams.join(',') === 'ITEM_SKU'],
    ['final action PROCEED', skuTurn.trace.action === 'PROCEED_TO_MAIN_AGENT'],
    ['workflow EXECUTED', skuTurn.trace.workflow.state === 'EXECUTED'],
    ['order preserved', args.order_id === '10231'],
    ['sku merged', args.sku === 'SHOE-WHT-02'],
    ['refund executed once', skuTurn.trace.tools.filter((tool) => tool.name === 'execute_refund' && tool.status === 'executed').length === 1],
  ]);
}

async function invalidSku() {
  const c1 = await turn(SCENARIO_C.message, []);
  const bad = await turn('order #10231 and sku 9999 because damaged', c1.history);

  report('invalid SKU asks only for the SKU and holds the refund', [
    ['action CLARIFY_GROUNDING', bad.trace.action === 'CLARIFY_GROUNDING'],
    ['workflow AWAITING_CLARIFICATION', bad.trace.workflow.state === 'AWAITING_CLARIFICATION'],
    ['order kept as candidate', checkValue(bad.trace, 'ORDER_ID')?.status === 'candidate'],
    ['SKU missing', checkValue(bad.trace, 'ITEM_SKU')?.present === false],
    ['only SKU requested this turn', checkValue(bad.trace, 'ITEM_SKU')?.present === false && bad.trace.grounding.missingParams.length === 1],
    ['reply asks for SKU', /item sku/i.test(bad.trace.assistantMessage)],
    ['refund not executed', bad.trace.tools.every((tool) => tool.status !== 'executed')],
  ]);
}

async function boundedRetries() {
  const c1 = await turn(SCENARIO_C.message, []);
  let history = c1.history;
  let escalated: Awaited<ReturnType<typeof turn>> | null = null;
  let clarificationTurns = 0;

  for (let index = 0; index < 5; index += 1) {
    const response = await turn("I'm not sure, please just do it", history);
    history = response.history;
    if (response.trace.action === 'CLARIFY_GROUNDING') {
      clarificationTurns += 1;
      continue;
    }
    escalated = response;
    break;
  }

  const limitEvent = escalated?.events.find((event) => event.stage === 'CLARIFICATION_LIMIT');
  report('repeated incomplete replies are bounded and escalated', [
    ['at most 3 clarification prompts', clarificationTurns <= 3],
    ['escalation happened', escalated !== null],
    ['action ESCALATED_TO_HUMAN', escalated?.trace.action === 'ESCALATED_TO_HUMAN'],
    ['workflow ESCALATED', escalated?.trace.workflow.state === 'ESCALATED'],
    ['clarification trace exhausted', escalated?.trace.workflow.clarification.exhausted === true],
    ['CLARIFICATION_LIMIT event emitted', Boolean(limitEvent)],
    ['ticket created', escalated?.trace.tools.some((tool) => tool.name === 'create_support_ticket' && tool.status === 'executed') === true],
    ['refund never executed', escalated?.trace.tools.every((tool) => tool.name !== 'execute_refund' || tool.status !== 'executed') === true],
  ]);
}

async function isolation() {
  const safe = await turn(SCENARIO_A.message, []);
  const afterSafe = await turn(SCENARIO_C.message, safe.history);
  const partial = await turn(SCENARIO_C.message, []);
  const partialOrder = await turn('10231', partial.history);
  const freshMessage = await turn(SCENARIO_C.message, partialOrder.history);
  const freshClientReset = await turn(SCENARIO_C.message, []);

  report('scenario state cannot leak between conversations', [
    ['A then C does not ground order', checkValue(afterSafe.trace, 'ORDER_ID')?.present === false],
    ['partial order was captured', checkValue(partialOrder.trace, 'ORDER_ID')?.value === '10231'],
    ['new C request detected as fresh', freshMessage.trace.workflow.freshRequest === true],
    ['fresh C request drops old order', checkValue(freshMessage.trace, 'ORDER_ID')?.present === false],
    ['fresh request starts at attempt 1', freshMessage.trace.workflow.clarification.attempt === 1],
    ['client reset starts clean', checkValue(freshClientReset.trace, 'ORDER_ID')?.present === false],
    ['no refund in any isolated turn', [afterSafe, freshMessage, freshClientReset].every((response) => response.trace.tools.every((tool) => tool.status !== 'executed'))],
  ]);
}

async function fraudIntercept() {
  const fraud = await turn(SCENARIO_B.message, []);

  report('fraud/injection request stays blocked', [
    ['label POTENTIAL_FRAUD_ABUSE', fraud.trace.decision.label === 'POTENTIAL_FRAUD_ABUSE'],
    ['action BLOCKED_BY_GUARDRAIL', fraud.trace.action === 'BLOCKED_BY_GUARDRAIL'],
    ['workflow BLOCKED', fraud.trace.workflow.state === 'BLOCKED'],
    ['Layer 3 not invoked', !fraud.trace.mainAgentInvoked],
    ['refund frozen, never executed', fraud.trace.tools.every((tool) => tool.name !== 'execute_refund' || tool.status !== 'executed')],
  ]);
}

async function telemetryAndGate() {
  const sessionId = 'session-acceptance';
  const response = await turn(SCENARIO_C.message, [], sessionId);
  const ids = response.events.map((event) => event.id);
  const complete = stageData(response.events, 'TURN_COMPLETE');

  report('telemetry is session-scoped, unique and stateful', [
    ['events emitted', response.events.length > 0],
    ['every event has session id', response.events.every((event) => event.sessionId === sessionId)],
    ['event ids unique', new Set(ids).size === ids.length],
    ['trace carries workflow', response.trace.workflow.state === 'AWAITING_CLARIFICATION'],
    ['TURN_COMPLETE carries workflow', complete.workflowState === 'AWAITING_CLARIFICATION'],
    ['TURN_COMPLETE carries attempt', complete.clarificationAttempt === 1],
    ['fresh request flag present', complete.freshRequest === false],
  ]);

  const gate = createTurnGate();
  const first = gate.tryAcquire();
  const duplicate = gate.tryAcquire();
  gate.release(first!);
  const afterRelease = gate.tryAcquire();
  gate.reset();
  gate.release(afterRelease!);
  const afterReset = gate.tryAcquire();

  report('turn gate blocks same-tick double submission', [
    ['first acquire succeeds', first !== null],
    ['second acquire blocked', duplicate === null],
    ['acquire works after release', afterRelease !== null],
    ['reset invalidates the old token and frees the gate', afterReset !== null],
  ]);
}

async function main() {
  console.log('── Scenario C acceptance ─────────────────────────────────────');
  const first = await scenarioCFirstTurn();
  await exactBothSlots(first);
  await separateSlots();
  await invalidSku();
  await boundedRetries();
  await isolation();

  console.log('');
  console.log('── Guardrails, telemetry and client isolation ────────────────');
  await fraudIntercept();
  await telemetryAndGate();

  console.log('');
  console.log(failures === 0 ? '✅ Scenario C accepted.' : `❌ ${failures} acceptance check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
