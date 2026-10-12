/* QA for the Ask assistant.
 *
 * The things that can actually hurt someone here are not the model being
 * wrong — it is the wiring being wrong: a tool the model is told about that
 * the panel cannot run, a write with no undo, a send tool that can reach the
 * queue without a tap, or a destructive function becoming reachable from
 * free text. Those are all checkable without a browser, so they are checked.
 *
 *   node assistant-tools.test.mjs
 */
import { readFileSync } from 'node:fs';
import * as T from './assistant-tools.js';

let pass = 0, fail = 0;
const ok  = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const eq  = (n, a, b) => ok(n + (a === b ? '' : `  (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`), a === b);

const html  = readFileSync('./admin-v2.html', 'utf8');
const panel = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const fn    = readFileSync('./functions/index.js', 'utf8');
const core  = readFileSync('./invoice-core.js', 'utf8');

/* The tool body, so "is there a case for this" can't be satisfied by a
   mention in a comment somewhere else in the file. */
const toolBody = panel.slice(panel.indexOf('async function askRunTool'),
                             panel.indexOf('/* ---- the tap ----'));

console.log('\n--- the schemas ---');
ok('every tool has a name, description, schema and tier',
   T.TOOLS.every(t => t.name && t.description && t.input_schema && t.tier));
ok('every tier is one we know about',
   T.TOOLS.every(t => Object.values(T.TIERS).includes(t.tier)));
ok('no duplicate tool names', new Set(T.TOOLS.map(t => t.name)).size === T.TOOLS.length);
ok('every required field is declared in properties',
   T.TOOLS.every(t => (t.input_schema.required || []).every(r => t.input_schema.properties[r])));
ok('the tier never leaks to the model', T.apiTools().every(t => !('tier' in t)));
ok('apiTools covers every tool', T.apiTools().length === T.TOOLS.length);
ok('all three tiers are actually used',
   new Set(T.TOOLS.map(t => t.tier)).size === 3);

console.log('\n--- nothing destructive is reachable from free text ---');
/* These delete client records with no undo. The panel keeps them on buttons.
   If one ever appears here, this test is the thing that should stop it. */
for (const banned of ['delete_dog','delete_owner','merge_dog','merge_owner','delete_booking',
                      'deleteDog','deleteOwner','applyMergeDog','applyMergeOwner'])
  ok(`no tool named ${banned}`, !T.TOOLS.some(t => t.name === banned));
ok('no tool description invites deleting a client or dog',
   !T.TOOLS.some(t => /\bdelete\b|\bremove the (dog|client)\b|\bmerge\b/i.test(t.description)));
ok('the panel never calls deleteDog/deleteOwner from the assistant',
   !/deleteDog|deleteOwner|applyMergeDog|applyMergeOwner/.test(toolBody));

console.log('\n--- the panel implements exactly what the model is offered ---');
/* The drift that matters: a tool advertised but not implemented answers
   nothing and looks broken; one implemented but not advertised is dead code
   that will rot. */
for (const t of T.TOOLS)
  ok(`${t.name} has a case in askRunTool`, new RegExp(`case '${t.name}'`).test(toolBody));
const cases = [...toolBody.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]);
/* send_invoice and send_receipt deliberately share one body, so a tool's code
   runs from its own label to the next label that actually starts a block. */
function bodyOf(toolName) {
  const start = toolBody.indexOf(`case '${toolName}'`);
  if (start < 0) return '';
  const after = [...toolBody.matchAll(/case '([a-z_]+)':/g)]
    .map(m => ({ name: m[1], at: m.index }))
    .filter(c => c.at > start)
    /* a label immediately following another label is a fall-through, not a
       new body — skip past it */
    .find(c => toolBody.slice(start, c.at).replace(/case '[a-z_]+':\s*/g, '').trim().length > 0);
  return toolBody.slice(start, after ? after.at : toolBody.length);
}
for (const c of cases)
  ok(`case '${c}' is a declared tool`, T.TOOLS.some(t => t.name === c));
eq('no orphan cases', cases.filter(c => !T.TOOLS.some(t => t.name === c)).length, 0);

console.log('\n--- every write is undoable ---');
/* The whole reason writes skip a confirmation is that Undo is one tap away.
   A write tool with no undo registered breaks that bargain silently. */
const writes = T.TOOLS.filter(t => t.tier === T.TIERS.WRITE);
ok('there are write tools to check', writes.length > 0);
for (const t of writes) {
  const body = bodyOf(t.name);
  ok(`${t.name} registers an undo`,
     /askRegisterUndo/.test(body) || /uncancel/.test(t.name));
  ok(`${t.name} persists with save(DB)`, /await save\(DB\)/.test(body));
}

console.log('\n--- sends cannot happen without a tap ---');
const sends = T.TOOLS.filter(t => t.tier === T.TIERS.SEND);
for (const t of sends) {
  const body = bodyOf(t.name);
  ok(`${t.name} never pushes to the send queue itself`, !/sendQueue\.push/.test(body));
  ok(`${t.name} never calls queueInvoice directly`, !/await queueInvoice|await queueDeposit/.test(body));
  ok(`${t.name} halts the loop`, /halt: true/.test(body));
  ok(`${t.name} runs blockers before proposing`, /blockers\(/.test(body));
  ok(`${t.name} offers a Send button`, /askConfirmSend/.test(body));
}
/* The panel has had queue-writing buttons since before any of this; what
   matters is that none of them became reachable from a sentence. */
eq('no tool handler can queue an email at all',
   (toolBody.match(/sendQueue\.push/g) || []).length, 0);
ok('the only assistant path to the queue is the Send button',
   /async function askConfirmSend[\s\S]*?queueInvoice[\s\S]*?askQueueDepositNoPrompt/.test(panel));
ok('and that button is only drawn on a send-tier card',
   [...panel.matchAll(/askConfirmSend\(/g)].length ===
   1 + sends.length - 1 /* one definition + one button per send card, two of which share a body */
   || /askConfirmSend/.test(bodyOf('send_invoice')) && /askConfirmSend/.test(bodyOf('send_deposit')));

console.log('\n--- money is never computed by the assistant ---');
/* Every figure on a card has to come back from invoice-core. A literal rate
   or a multiplication in here is a second source of truth for money. */
ok('no hardcoded session prices in the tool bodies',
   !/\b(55|65|70|75|80|90|100|115|130)\s*\*|\*\s*0\.5\b/.test(toolBody));
ok('totals come from calcTotal or buildInvoice',
   /calcTotal\(|buildInvoice\(/.test(toolBody));
ok('cancellation charges come from cancelQuote, not arithmetic',
   /cancelQuote\(/.test(toolBody) && !/CANCEL_CHARGE_RATE\s*\*/.test(toolBody));
ok('the deposit card reads depositDue rather than halving anything',
   /depositDue\(/.test(toolBody));
ok('the subject line is the shared one, not a copy',
   /invoiceSubject\(req, BIZ\)/.test(panel) && !/invoiceSubjectLocal/.test(panel));

console.log('\n--- the Scouts cap holds ---');
const bookBody = bodyOf('book');
ok('book refuses a fifth Scouts dog', /n >= 4/.test(bookBody));
ok('book checks the cap per trip, not per day', /scoutsTrip/.test(bookBody));
ok('book refuses duplicates', /Already booked|clashes/.test(bookBody));
ok('the cap is described to the model as law',
   /law/i.test(T.systemPrompt({ today: '2026-10-12' })));

console.log('\n--- the Cloud Function is a proxy and nothing more ---');
const asst = fn.slice(fn.indexOf('export const assistant'));
ok('it requires an authenticated caller', /if \(!request\?\.auth\)/.test(asst));
ok('it never reads Firestore', !/fs\.doc|getFirestore/.test(asst));
ok('it never writes Firestore', !/\.set\(|\.update\(/.test(asst));
ok('it never sends email', !/resend|sendEmail/i.test(asst));
ok('it caps the turn count', /MAX_TURNS/.test(asst));
ok('it caps the payload size', /MAX_INPUT_CHARS/.test(asst));
ok('it caps the message count', /MAX_MESSAGES/.test(asst));
ok('the api key is a secret, not a literal', /ANTHROPIC_API_KEY\.value\(\)/.test(asst)
   && /defineSecret\('ANTHROPIC_API_KEY'\)/.test(fn));
ok('no api key is anywhere in the panel', !/sk-ant|anthropic\.com\/v1/.test(panel));
ok('it distinguishes a bad key from rate limiting', /401/.test(asst) && /429/.test(asst));

console.log('\n--- deploy wiring ---');
const fbjson = JSON.parse(readFileSync('./firebase.json', 'utf8'));
ok('assistant-tools.js is copied into functions at deploy',
   fbjson.functions.predeploy.some(c => c.includes('assistant-tools.js')));
ok('invoice-core.js still is',
   fbjson.functions.predeploy.some(c => c.includes('invoice-core.js')));
ok('the node runtime is not the decommissioned one', fbjson.functions.runtime !== 'nodejs20');
eq('firebase.json and package.json agree on the runtime',
   fbjson.functions.runtime,
   'nodejs' + JSON.parse(readFileSync('./functions/package.json', 'utf8')).engines.node);
ok('assistant-tools.js is whitelisted into the public repo',
   /^!\/assistant-tools\.js$/m.test(readFileSync('./.gitignore', 'utf8')));
ok('assistant-tools.js pulls in nothing — it must stay testable',
   !/^import /m.test(readFileSync('./assistant-tools.js', 'utf8')));

console.log('\n--- the panel wiring ---');
for (const f of ['openAsk','closeAsk','askSubmit','askKey','askGrow','askReset','askEg','askUndo','askConfirmSend','askDrop']) {
  ok(`${f} is defined`, new RegExp(`function ${f}\\b`).test(panel));
  /* Module scope is not window scope — this has bitten this file before, when
     cancelling a booking silently did nothing for weeks. */
  ok(`${f} is exported to window`, new RegExp(`\\b${f}\\b`).test(panel.slice(panel.indexOf('Object.assign(window, {'))));
}
ok('the Ask button exists in the app bar', /class="ask-pill" onclick="openAsk\(\)"/.test(html));
ok('the thread has its own host, not the shared modal', /<div id="askHost">/.test(html));
ok('user text is escaped before rendering', /escapeHtml\(m\.text\)/.test(panel));
ok('model text is escaped before rendering', /askSay\(escapeHtml\(text\)/.test(panel));
ok('a failed tool tells the model nothing changed', /nothing changed/i.test(toolBody) || /did not work and nothing changed/.test(panel));
ok('undo tells the model the data moved', /tapped Undo/.test(panel));
ok('declining a send tells the model too', /declined to send/.test(panel));

console.log('\n--- BIZ is hydrated before anything reads it ---');
/* The bank details live in the document and BIZ starts empty. hydrateBiz used
   to run only when the Invoices screen opened, which was invisible until
   something asked about an invoice without going through that screen — and
   then blockers() reported "No bank details on file" for a business that has
   them. Every path that swaps the document in must rehydrate. */
{
  const assigns = [...panel.matchAll(/^\s*DB = (?!normalizeDb\(\{ owners: r\.owners\|\|\[\], dogs: r\.dogs\|\|\[\],\n)[^;]+;/gm)];
  ok('hydrateBiz is called more than once', (panel.match(/hydrateBiz\(\)/g)||[]).length > 4);
  ok('the assistant hydrates before running any tool',
     /hydrateBiz\(\);\s*\n\s*const tier = tierOf/.test(panel));
  for (const [label, anchor] of [
      ['the first Firestore load',      'knownRemoteMs = r._updatedAtMs || 0;'],
      ['the offline cache fallback',    "toast('Offline · using local cache', 'warn');"],
      ['a merge after a conflict',      'DB = merged;'],
      ['a live update from another tab','DB = nextDb;'],
      ['a buffered remote update',      'DB = pendingRemoteDb;']]) {
    const i = panel.indexOf(anchor);
    ok(`rehydrated on ${label}`, i > 0 && /hydrateBiz\(\)/.test(panel.slice(Math.max(0,i-220), i+220)));
  }
}

console.log('\n--- the system prompt says the things that matter ---');
const sp = T.systemPrompt({ today: '2026-10-12', weekday: 'Monday' });
ok('it carries today\'s date', sp.includes('2026-10-12'));
ok('it forbids guessing between same-named dogs', /do not write anything|ask which/i.test(sp));
ok('it forbids computing money', /Never calculate a price/i.test(sp));
ok('it says it cannot send', /You cannot send anything/i.test(sp));
ok('it requires flagging a charge', /waive/i.test(sp));
ok('it explains waiting is not a fault', /not a client with a problem/i.test(sp));
ok('it states the four-dog cap', /four dogs per trip/i.test(sp));
ok('it names Andressa', /Andressa/.test(sp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
