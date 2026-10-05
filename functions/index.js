/* Pansi's Paws — the part that actually sends invoices.
 *
 * The admin panel can't send email and isn't always open, so the deciding and
 * sending happen here. Two entry points:
 *
 *   onStateChanged  fires whenever the panel writes. Drains the send queue, and
 *                   in automatic mode sends to any client whose week has just
 *                   finished — which is usually the moment their last dog of the
 *                   week is collected, not Friday.
 *   nightlySweep    7pm Sydney, catches anything the trigger missed (a date
 *                   rolling over, a failed send) and emails Andressa a digest.
 *
 * Money is never recalculated here. invoice-core.js is copied in at deploy time
 * and is the same file the panel uses.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import {
  setPricing, planRun, buildInvoice, renderInvoiceEmail, invoiceText, invoiceSubject,
  orphanBookings, addDaysISO, sendableInvoices
} from './invoice-core.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

setGlobalOptions({ region: 'australia-southeast1', maxInstances: 2 });
initializeApp();
const fs = getFirestore();
const STATE = 'pansis-admin/state';

/* Sydney's date, not the server's. A run at 09:00 UTC is already tomorrow here. */
const sydneyToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year:'numeric', month:'2-digit', day:'2-digit' })
    .format(new Date());

const DEFAULT_BIZ = {
  name: "Pansi's Paws Home Daycare", person: 'Andressa Ubida Fernandes', suburb: 'Annandale, Sydney',
  phone: '0410 151 509', email: 'andressa@pansispaws.com.au', site: 'pansispaws.com.au',
  acctName: '', bsb: '', acct: '', abn: '', stripeLink: '', bankDiscount: 0
};

async function loadPricing() {
  try {
    const r = await fetch('https://pansispaws.com.au/pricing.json');
    if (r.ok) setPricing(await r.json());
  } catch (e) { logger.warn('pricing.json unavailable, using built-in defaults', e); }
}

/* ---------- sending ---------- */

/* Resend will send from this without any DNS set up, but only to the address
   that owns the Resend account. Fine for a test, useless for a client. */
const SHARED_SENDER = 'Pansi\'s Paws <onboarding@resend.dev>';
const ownSender = cfg => cfg?.mailFrom || '';

async function sendMail({ to, from, replyTo, bcc, subject, html, text, apiKey, idempotencyKey }) {
  /* Resend keeps an idempotency key for 24 hours and returns the original
     response instead of sending again. Siena Edwards received the same invoice
     four times because four overlapping runs each read the ledger before any of
     them had written to it; the Firestore claim below is the real fix, but this
     is the one that holds even if the claim logic is wrong, because it does not
     depend on our own state being consistent. */
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
               ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}) },
    body: JSON.stringify({
      from: from || SHARED_SENDER,
      to: [to], reply_to: replyTo || undefined,
      /* Resend sends these, not Outlook, so nothing lands in Andressa's Sent
         folder — she had the digest and no copy of what a client actually
         received. A blind copy to herself gives her the real thing, in her own
         mailbox, searchable, when someone says it never arrived. */
      bcc: bcc ? [bcc] : undefined,
      subject, html, text
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).id;
}

/* ---------- the run ---------- */

async function runInvoicing(reason, apiKey) {
  const snap = await fs.doc(STATE).get();
  if (!snap.exists) return { skipped: 'no state document' };
  const state = snap.data();

  const cfg = state.meta?.invoicing || {};
  // meta.biz can override the contact address, so a bouncing one can be fixed
  // from the panel without a redeploy.
  const biz = { ...DEFAULT_BIZ, ...(state.meta?.biz || {}) };
  if (cfg.mode !== 'auto' && cfg.mode !== 'approve') return { skipped: `mode is ${cfg.mode || 'off'}` };
  if (!biz.bsb || !biz.acct) return { skipped: 'no bank details on file' };
  // A client must never receive an invoice from a shared testing address —
  // it looks like a scam and it won't survive their spam filter.
  if (!ownSender(cfg)) return { skipped: 'no verified sending address — set mailFrom once the domain is verified in Resend' };

  await loadPricing();
  const today = sydneyToday();

  /* Everything about what should go out is decided in invoice-core, with no
     IO, so it is testable and so the panel agrees about what would happen. */
  const plan = planRun(state, biz, cfg, today);
  if (plan.skipped) return { skipped: plan.skipped };
  const { jobs, refused } = plan;

  if (plan.held) {
    /* A sudden pile almost always means bookings were imported or back-filled,
       not that fifteen dogs finished at once. Stop and ask. */
    await notifyAndressa(cfg, biz, apiKey, `Held ${plan.held.length} invoices`,
      `${plan.held.length} invoices came up at once, more than the ${plan.cap} you'd expect in a normal run, so none were sent.\n\n` +
      plan.held.map(i => `  ${i.owner.name} — $${i.total.toFixed(2)} (${i.lines.length} lines)`).join('\n') +
      `\n\nOpen the panel and send them by hand if that's right, or raise the limit in Invoices → Change.`,
      `held/${today}/${plan.held.length}`);
    await fs.doc(STATE).update({ 'meta.invoicingLastRun': { at: new Date().toISOString(), reason, held: plan.held.length } });
    return { held: plan.held.length };
  }
  /* Approve mode only ever acts on what Andressa has already tapped. Without
     this, an invoice that is ready but unapproved sits silently forever and the
     only way to find out is to open the panel and look. Tell her instead. */
  const waiting = cfg.mode === 'approve'
    ? sendableInvoices(state, biz, { asAt: today, from: cfg.goLive || undefined })
        .filter(inv => !(state.meta?.sendQueue || []).some(q => q.ownerId === inv.owner.id))
    : [];

  if (!jobs.length && !refused.length) {
    if (waiting.length && reason === 'nightly sweep') {
      await notifyAndressa(cfg, biz, apiKey,
        `${waiting.length} invoice${waiting.length === 1 ? '' : 's'} ready to approve`,
        `These are finished and waiting for you. Nothing goes until you tap send.\n\n` +
        waiting.map(i => `  ${i.owner.name} — $${i.total.toFixed(2)}`).join('\n') +
        `\n\nTotal $${waiting.reduce((t, i) => t + i.total, 0).toFixed(2)}\n\n` +
        `Open the panel → Invoices to look them over.`,
        `waiting/${today}/${waiting.map(i => i.owner.id).sort().join('-')}`);
      return { waiting: waiting.length };
    }
    return { skipped: 'nothing ready' };
  }

  /* Claim each invoice in a transaction before a single email goes out.

     The trigger fires on any write that touches bookings, the queue or the
     settings, so four saves in quick succession start four runs. Each one read
     the state, saw nothing billed, and sent — and the ledger write that would
     have stopped the next one had not landed yet. That is how one $102 invoice
     reached a client four times.

     A claim is a write, so Firestore serialises it: whichever run gets there
     first owns that invoice number and the others skip it. Stale claims expire
     so a crashed run cannot wedge an invoice forever. */
  const CLAIM_TTL_MS = 10 * 60 * 1000;
  const claimed = [];
  if (jobs.length) {
    await fs.runTransaction(async tx => {
      const cur  = (await tx.get(fs.doc(STATE))).data() || {};
      const meta = cur.meta || {};
      const billed = meta.billed || {};
      const already = new Set((meta.invoicesSent || []).map(x => x.number));
      const inFlight = meta.sending || {};
      const now = Date.now();
      claimed.length = 0;
      for (const inv of jobs) {
        if (already.has(inv.number)) continue;                       // already gone out
        if (inv.bookingIds.some(id => billed[id])) continue;         // its days are billed
        const held = inFlight[inv.number];
        if (held && now - held < CLAIM_TTL_MS) continue;             // another run has it
        inFlight[inv.number] = now;
        claimed.push(inv);
      }
      meta.sending = inFlight;
      tx.update(fs.doc(STATE), { meta });
    });
  }
  if (jobs.length && !claimed.length) return { skipped: 'already in flight' };

  const sent = [], failed = [];
  for (const inv of claimed) {
    try {
      const id = await sendMail({
        to: inv.owner.email, from: ownSender(cfg), replyTo: cfg.replyTo || biz.email,
        bcc: cfg.copyTo || cfg.digestTo || undefined, apiKey,
        idempotencyKey: `invoice/${inv.number}`,
        subject: invoiceSubject(inv, biz),
        html: renderInvoiceEmail(inv, biz), text: invoiceText(inv, biz)
      });
      sent.push({ inv, id });
    } catch (e) {
      logger.error('send failed', inv.owner.name, e);
      failed.push({ who: inv.owner.name, number: inv.number, why: String(e.message || e) });
    }
  }

  /* Only now does anything get marked as billed — a send that threw must come
     round again next run rather than disappearing. */
  // A send that threw stays in the queue so it is tried again. Only what
  // actually went, or what a person has to deal with, leaves the queue.
  const dealtWith = new Set([...sent.map(x => x.inv.owner.id), ...refused.map(r => r.ownerId)]);
  if (dealtWith.size) {
    await fs.runTransaction(async tx => {
      const cur = (await tx.get(fs.doc(STATE))).data();
      const meta = cur.meta || {};
      meta.billed = meta.billed || {};
      meta.invoicesSent = meta.invoicesSent || [];
      sent.forEach(({ inv, id }) => {
        inv.bookingIds.forEach(bid => { meta.billed[bid] = inv.number; });
        meta.invoicesSent.push({
          number: inv.number, ownerId: inv.owner.id, ownerName: inv.owner.name,
          /* The reference is what the client types into their bank, so it is
             the one field that lets a credit be matched to an invoice with
             certainty rather than by guessing at names. Recording the due date
             alongside it is what makes "who is overdue" answerable at all. */
          ref: inv.ref, dueISO: inv.dueISO,
          asAt: inv.asAt, total: inv.total, bookingIds: inv.bookingIds,
          to: inv.owner.email, providerId: id,
          sentAt: new Date().toISOString(), mode: cfg.mode, reason,
          paidAt: null, paidAmount: null
        });
      });
      // Clear the queue entries we dealt with, either way — a refusal that stays
      // queued would be retried on every single write.
      meta.sendQueue = (meta.sendQueue || []).filter(q => !dealtWith.has(q.ownerId));
      /* Let go of the claims. A send that went is protected by invoicesSent
         from here on; one that threw should be free to try again next run. */
      meta.sending = meta.sending || {};
      [...sent.map(x => x.inv.number), ...failed.map(f => f.number).filter(Boolean)]
        .forEach(n => { delete meta.sending[n]; });
      meta.invoicingLastRun = { at: new Date().toISOString(), reason,
                                sent: sent.length, failed: failed.length, refused: refused.length };
      /* A refused invoice used to vanish from the queue and silently reappear
         under "Ready to send" with a different amount and its button back —
         the same shape as the bug that sent one client four copies. Write the
         reasons down so the panel can say what happened. A failure goes here
         too: it stays queued and will be retried, but she should know. */
      meta.invoicingRefused = [
        ...refused.map(r => ({ ownerId: r.ownerId, who: r.who, why: r.why,
                               at: new Date().toISOString(), kind: 'refused' })),
        ...failed.map(f => ({ who: f.who, number: f.number, why: f.why,
                              at: new Date().toISOString(), kind: 'failed' }))
      ];
      tx.update(fs.doc(STATE), { meta });
    });
  }

  await digest(cfg, biz, apiKey, state, today, sent, failed, refused, waiting);
  return { sent: sent.length, failed: failed.length, refused: refused.length, waiting: waiting.length };
}

/* ---------- telling Andressa ---------- */

async function notifyAndressa(cfg, biz, apiKey, subject, body, idempotencyKey) {
  const to = cfg.digestTo || biz.email;
  if (!to) return;
  try {
    await sendMail({ to, from: ownSender(cfg) || undefined, apiKey, idempotencyKey,
      subject: `Pansi's Paws — ${subject}`,
      html: `<pre style="font:14px/1.6 -apple-system,Helvetica,Arial,sans-serif;white-space:pre-wrap">${body
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`, text: body });
  } catch (e) { logger.error('could not reach Andressa', e); }
}

async function digest(cfg, biz, apiKey, state, today, sent, failed, refused, waiting = []) {
  if (!sent.length && !failed.length && !refused.length && !waiting.length) return;
  const orphans = orphanBookings(state, cfg.goLive || '0000-01-01', today);

  /* Every invoice is blind-copied to Andressa, so after a quiet run of one the
     digest is a second email telling her about an email she already has. She
     got two notifications a minute apart for a single $102 invoice and
     reasonably read it as a double-send.

     So the digest only goes when it carries something the copies do not: more
     than one invoice to total up, a failure, something refused, something
     waiting on her, or a booking that cannot be billed at all. A single clean
     send speaks for itself. */
  const bccAddr    = (cfg.copyTo || cfg.digestTo || '').trim().toLowerCase();
  const digestAddr = (cfg.digestTo || biz.email || '').trim().toLowerCase();
  const alreadyTold = bccAddr && bccAddr === digestAddr;
  if (alreadyTold && sent.length === 1
      && !failed.length && !refused.length && !waiting.length && !orphans.length) return;

  const L = [];
  if (sent.length) {
    L.push(`Sent (${sent.length}) — $${sent.reduce((s,x) => s + x.inv.total, 0).toFixed(2)}`);
    sent.forEach(({ inv }) => L.push(`  ${inv.owner.name} — $${inv.total.toFixed(2)} — ${inv.number}`));
  }
  if (failed.length) {
    L.push('', `Would not send (${failed.length}) — these will be tried again`);
    failed.forEach(f => L.push(`  ${f.who} — ${f.why}`));
  }
  if (refused.length) {
    L.push('', `Needs you (${refused.length})`);
    refused.forEach(f => L.push(`  ${f.who} — ${f.why}`));
  }
  if (waiting.length) {
    L.push('', `Ready to approve (${waiting.length}) — $${waiting.reduce((t,i)=>t+i.total,0).toFixed(2)}`);
    waiting.forEach(i => L.push(`  ${i.owner.name} — $${i.total.toFixed(2)}`));
  }
  if (orphans.length) L.push('', `${orphans.length} booking${orphans.length===1?'':'s'} can't be billed — no dog or owner on file.`);
  /* Keyed on exactly what it says, so four runs reporting the same thing send
     one email rather than four. A genuinely different run says something
     different and gets a different key. */
  await notifyAndressa(cfg, biz, apiKey,
    sent.length ? `${sent.length} invoice${sent.length===1?'':'s'} sent` : 'invoices need a look',
    L.join('\n'),
    `digest/${today}/${[...sent.map(x => x.inv.number), ...failed.map(f => f.number || f.who),
                        ...refused.map(r => r.ownerId), ...waiting.map(i => i.owner.id)].sort().join('-')}`);
}

/* ---------- triggers ---------- */

/* Writing the ledger back re-fires this trigger. That's fine and it settles:
   the second pass finds everything already billed and stops. The guard below
   just saves the round trip. */
export const onStateChanged = onDocumentWritten(
  { document: 'pansis-admin/state', secrets: [RESEND_API_KEY] },
  async event => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!after) return;

    const bookingsChanged = JSON.stringify(before?.bookings || []) !== JSON.stringify(after.bookings || []);
    const queueGrew = (after.meta?.sendQueue?.length || 0) > (before?.meta?.sendQueue?.length || 0);
    const settingsChanged = JSON.stringify(before?.meta?.invoicing || {}) !== JSON.stringify(after.meta?.invoicing || {});
    if (!bookingsChanged && !queueGrew && !settingsChanged) return;

    const r = await runInvoicing(queueGrew ? 'approved in the panel' : 'a booking changed', RESEND_API_KEY.value());
    logger.info('invoicing run', r);
  }
);

export const nightlySweep = onSchedule(
  { schedule: '0 19 * * *', timeZone: 'Australia/Sydney', secrets: [RESEND_API_KEY] },
  async () => {
    const r = await runInvoicing('nightly sweep', RESEND_API_KEY.value());
    logger.info('nightly sweep', r);
  }
);

/* ---------- a test send, before any of this touches a client ---------- */

/* Fires one invoice at an address you name, built from made-up bookings — no
   client data, no ledger write, nothing marked as billed. This is how you check
   that Resend is configured, the domain verifies, and the thing actually looks
   right in Gmail rather than in a preview.
 *
 *   firebase functions:shell
 *   sendTestInvoice({to: 'you@example.com'})
 *
 * or, deployed:
 *   curl -X POST https://australia-southeast1-pansi-paws.cloudfunctions.net/sendTestInvoice \
 *        -H 'Content-Type: application/json' -d '{"data":{"to":"you@example.com"}}'
 */
export const sendTestInvoice = onCall(
  { secrets: [RESEND_API_KEY] },
  async request => {
    /* The functions shell passes the raw body for v2 callables, so the argument
       arrives unwrapped there and wrapped in .data everywhere else. Accept both
       rather than making the caller remember which. */
    /* Callable functions are public URLs. Without this anyone who knows the
       project id can post an address and have a real invoice — carrying the
       real BSB and account number — sent from the verified domain. */
    if (!request?.auth) throw new HttpsError('unauthenticated',
      'Sign in to the panel first. This sends a real email with real bank details on it.');

    const snap = await fs.doc(STATE).get();
    const cfgEarly = snap.exists ? snap.data().meta?.invoicing || {} : {};

    /* A test send can only reach us. The fixture is invented and nothing is
       marked billed, but the email carries the real business name, the real BSB
       and the real account number, and it is indistinguishable from a genuine
       invoice in an inbox. One slip of a finger onto a client address and they
       are looking at a bill for a dog called Biscuit. So the address is not
       free text: it defaults to Simon and refuses anything not on this list. */
    const SAFE_TEST_RECIPIENTS = [
      'simon.horowitz44@gmail.com',
      'andressa.ubf@hotmail.com',
      cfgEarly.digestTo, cfgEarly.copyTo
    ].filter(Boolean).map(x => String(x).trim().toLowerCase());

    const to = String(request?.data?.to || request?.to || SAFE_TEST_RECIPIENTS[0]).trim();
    if (!/.+@.+\..+/.test(to)) throw new HttpsError('invalid-argument',
      'That is not an email address. Leave "to" out entirely and it goes to Simon.');
    if (!SAFE_TEST_RECIPIENTS.includes(to.toLowerCase())) throw new HttpsError('permission-denied',
      `Test invoices only go to us, never to a client address. Allowed: ${SAFE_TEST_RECIPIENTS.join(', ')}.`);

    const biz = { ...DEFAULT_BIZ, ...(snap.exists ? snap.data().meta?.biz || {} : {}) };
    const cfg = cfgEarly;
    if (!biz.bsb || !biz.acct) throw new HttpsError('failed-precondition',
      'No BSB or account number set. Add them in the panel first — otherwise the test invoice has no way to pay it.');
    await loadPricing();

    const today = sydneyToday();
    // addDaysISO, not toISOString — the latter converts to UTC, so east of
    // Greenwich every date comes out a day early.
    const day = n => addDaysISO(today, -n);

    /* Deliberately a busy week: a Scouts run, a pack day, a late pickup and a
       late cancellation, so one email shows every kind of line. */
    const fixture = {
      meta: { billed:{}, invoicesSent:[], sendQueue:[], invoicing:{ goLive: day(30) } },
      owners: [{ id:'test_owner', name:'Sample Client', email: to }],
      dogs:   [{ id:'test_dog', ownerId:'test_owner', name:'Biscuit', size:'medium' }],
      packs:  [{ id:'test_pack', dogId:'test_dog', size:10, daysUsed:2, expiryDate: day(-60) }],
      bookings: [
        { id:'t1', dogId:'test_dog', date: day(4), session:'scouts', scoutsTrip:'am' },
        { id:'t2', dogId:'test_dog', date: day(3), session:'full', departureLogged:'16:20' },
        { id:'t3', dogId:'test_dog', date: day(2), session:'full', packId:'test_pack', departureLogged:'16:05' },
        { id:'t4', dogId:'test_dog', date: day(1), session:'full', departureLogged:'18:40' },
        { id:'t5', dogId:'test_dog', date: day(1), session:'full', cancelled:true, cancelCharge:45 },
        /* A stay collected outside its window, so the sample also shows the
           check-in charge explaining itself. */
        { id:'t6', dogId:'test_dog', date: day(5), session:'overnight',
          arrivalLogged:'13:00', departureLogged:'11:30' }
      ]
    };

    const inv = buildInvoice(fixture, 'test_owner', { asAt: today });
    if (!inv) throw new HttpsError('internal', 'The fixture produced no invoice, which should not happen.');

    /* Falls back to Resend's shared sender so this works before the domain is
       verified — it will only reach the Resend account owner, which is the
       point of a test. Real invoices refuse to use it. */
    const from = ownSender(cfg);
    const id = await sendMail({
      to, from: from || undefined, apiKey: RESEND_API_KEY.value(),
      subject: `[TEST] ${invoiceSubject(inv, biz)}`,
      html: renderInvoiceEmail(inv, biz), text: invoiceText(inv, biz)
    });
    logger.info('test invoice sent', { to, total: inv.total, id });
    return { sent: to, from: from || SHARED_SENDER, total: inv.total, lines: inv.lines.length, providerId: id,
             note: from
               ? 'Made-up bookings. Nothing was marked as billed and no client was touched.'
               : "Made-up bookings, sent from Resend's shared address because no verified domain is set yet. Real invoices will not send until meta.invoicing.mailFrom is set." };
  }
);

/* ---------- one-off: the invoicing notice that never arrived ---------- */

/* On 27 September the client announcement went out as a single message with 41
   recipients. Every hotmail, outlook, bigpond and ozemail address received it.
   Every single gmail address bounced — 26 of them — after four delivery attempts
   across fourteen hours, with "recipient's mail server not found", which is
   plainly not true of gmail.com. One-to-one sending to the same addresses works
   (Siena's invoice reached her gmail four times over), so the shape of the send
   is what Google refused, not the domain.

   So this sends the same notice one email at a time. The list is the verified
   bounce list from that send, written out rather than derived, because a rule
   like "every gmail client" would quietly include anyone added since.

   The copy is amended twice over: the original promised invoicing "from Monday
   21 September", which is long past and several of these people have had an
   invoice already; and it quoted the old 5.30pm pickup with fifteen minutes'
   grace, which is now 5pm with thirty. */

const NOTICE_BOUNCED = [
  'aguerron97@gmail.com', 'anand.gururajan@gmail.com', 'ashleigh.bruton@gmail.com',
  'asjanwalikar@gmail.com', 'beckyjcater@gmail.com', 'benxrach@gmail.com',
  'dariojuniorsyd@gmail.com', 'davelewin59@gmail.com', 'eduarda.araujo2305@gmail.com',
  'emilylaw00@gmail.com', 'emma.j.ferguson1@gmail.com', 'hacy.tree@gmail.com',
  'kirsten.lowe@gmail.com', 'ks.demina@gmail.com', 'kvrifkin@gmail.com',
  'maripgalasso@gmail.com', 'mikemeloshea@gmail.com', 'nicoleljack@gmail.com',
  'p.chaimongkol2@gmail.com', 'shysvirk@gmail.com', 'sienaaedwards@gmail.com',
  'simon.horowitz44@gmail.com', 'slopesjacque@gmail.com', 'sweetinglaura@gmail.com',
  'thegingrvintage@gmail.com', 'zoe4mclean@gmail.com'
];

const NOTICE_SUBJECT = 'A small change to how I invoice';

const NOTICE_TEXT = `Hello,

A bit of housekeeping, and then back to the dogs.

I sent this a couple of weeks ago and it didn't reach everyone — that's on me. If you've already had an invoice from me without this turning up first, I'm sorry for the muddle.

At the end of each week your dog has been with me, I'll email you an invoice rather than us sorting it out between ourselves. It lists every day they came, what each one cost, and the total, so you can see exactly what you're paying for.

Paying — bank transfer, details on the invoice, within 7 days. Each invoice carries a short reference; using it means I can match your payment without having to ask.

While I'm here, the two things that occasionally come up, so they're never a surprise on an invoice:

If you need to cancel — more than 24 hours' notice and there's no charge at all. Inside 24 hours it's half the day's rate, because our groups are small and a late cancellation usually can't be filled. If your dog is unwell, always keep them home — I'll credit the day rather than charge it.

Our day finishes at 5pm now, with half an hour's grace, so nothing applies until after 5.30. After that it's $10 per half hour, capped at $40. Life happens — message me if you're running late and we'll sort it out.

Both are written up properly at pansispaws.com.au/terms.html if you'd like the detail.

Nothing else changes. Same dogs, same days, same walks.

Andressa
Pansi's Paws Home Daycare
0410 151 509`;

/*  sendInvoicingNotice({mode: 'test'})  — goes to Simon alone
 *  sendInvoicingNotice({mode: 'send'})  — goes to the 26, one at a time
 */
export const sendInvoicingNotice = onCall(
  { secrets: [RESEND_API_KEY] },
  async request => {
    if (!request?.auth) throw new HttpsError('unauthenticated', 'Sign in to the panel first.');
    const mode = request?.data?.mode || request?.mode || 'test';
    if (!['test', 'send'].includes(mode)) throw new HttpsError('invalid-argument',
      "mode must be 'test' (Simon only) or 'send' (the 26 who bounced).");

    const snap = await fs.doc(STATE).get();
    const biz  = { ...DEFAULT_BIZ, ...(snap.exists ? snap.data().meta?.biz || {} : {}) };
    const cfg  = snap.exists ? snap.data().meta?.invoicing || {} : {};
    const list = mode === 'test' ? ['simon.horowitz44@gmail.com'] : NOTICE_BOUNCED;

    const html = `<div style="font:15px/1.65 -apple-system,Helvetica,Arial,sans-serif;color:#3f2814;max-width:560px">`
      + NOTICE_TEXT.split('\n\n').map(p =>
          `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('')
      + `</div>`;

    const done = [], bad = [];
    for (const to of list) {
      try {
        const id = await sendMail({
          to, from: ownSender(cfg), replyTo: cfg.replyTo || biz.email, apiKey: RESEND_API_KEY.value(),
          /* Keyed per recipient and dated, so running this twice cannot send a
             second copy to anyone within 24 hours. */
          idempotencyKey: `notice/2026-10-05/${to}`,
          subject: mode === 'test' ? `[TEST] ${NOTICE_SUBJECT}` : NOTICE_SUBJECT,
          html, text: NOTICE_TEXT
        });
        done.push({ to, id });
      } catch (e) {
        logger.error('notice failed', to, e);
        bad.push({ to, why: String(e.message || e) });
      }
      /* One at a time with a breath in between. A burst from a domain this young
         is what got the first attempt refused. */
      await new Promise(r => setTimeout(r, 1200));
    }

    if (mode === 'send') {
      await fs.doc(STATE).update({
        'meta.noticesSent': { at: new Date().toISOString(), subject: NOTICE_SUBJECT,
                              delivered: done.map(d => d.to), failed: bad }
      });
    }
    logger.info('invoicing notice', mode, 'sent', done.length, 'failed', bad.length);
    return { mode, sent: done.length, failed: bad.length, failures: bad };
  }
);
