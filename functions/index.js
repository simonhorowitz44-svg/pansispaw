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
  orphanBookings, addDaysISO
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

async function sendMail({ to, from, replyTo, subject, html, text, apiKey }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: from || SHARED_SENDER,
      to: [to], reply_to: replyTo || undefined, subject, html, text
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
      `\n\nOpen the panel and send them by hand if that's right, or raise the limit in Invoices → Change.`);
    await fs.doc(STATE).update({ 'meta.invoicingLastRun': { at: new Date().toISOString(), reason, held: plan.held.length } });
    return { held: plan.held.length };
  }
  if (!jobs.length && !refused.length) return { skipped: 'nothing ready' };

  const sent = [], failed = [];
  for (const inv of jobs) {
    try {
      const id = await sendMail({
        to: inv.owner.email, from: ownSender(cfg), replyTo: cfg.replyTo || biz.email, apiKey,
        subject: invoiceSubject(inv, biz),
        html: renderInvoiceEmail(inv, biz), text: invoiceText(inv, biz)
      });
      sent.push({ inv, id });
    } catch (e) {
      logger.error('send failed', inv.owner.name, e);
      failed.push({ who: inv.owner.name, why: String(e.message || e) });
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
          asAt: inv.asAt, total: inv.total, bookingIds: inv.bookingIds,
          to: inv.owner.email, providerId: id,
          sentAt: new Date().toISOString(), mode: cfg.mode, reason
        });
      });
      // Clear the queue entries we dealt with, either way — a refusal that stays
      // queued would be retried on every single write.
      meta.sendQueue = (meta.sendQueue || []).filter(q => !dealtWith.has(q.ownerId));
      meta.invoicingLastRun = { at: new Date().toISOString(), reason, sent: sent.length, failed: failed.length };
      tx.update(fs.doc(STATE), { meta });
    });
  }

  await digest(cfg, biz, apiKey, state, today, sent, failed, refused);
  return { sent: sent.length, failed: failed.length, refused: refused.length };
}

/* ---------- telling Andressa ---------- */

async function notifyAndressa(cfg, biz, apiKey, subject, body) {
  const to = cfg.digestTo || biz.email;
  if (!to) return;
  try {
    await sendMail({ to, from: ownSender(cfg) || undefined, apiKey, subject: `Pansi's Paws — ${subject}`,
      html: `<pre style="font:14px/1.6 -apple-system,Helvetica,Arial,sans-serif;white-space:pre-wrap">${body
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`, text: body });
  } catch (e) { logger.error('could not reach Andressa', e); }
}

async function digest(cfg, biz, apiKey, state, today, sent, failed, refused) {
  if (!sent.length && !failed.length && !refused.length) return;
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
  const orphans = orphanBookings(state, cfg.goLive || '0000-01-01', today);
  if (orphans.length) L.push('', `${orphans.length} booking${orphans.length===1?'':'s'} can't be billed — no dog or owner on file.`);
  await notifyAndressa(cfg, biz, apiKey,
    sent.length ? `${sent.length} invoice${sent.length===1?'':'s'} sent` : 'invoices need a look',
    L.join('\n'));
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
    const to = request?.data?.to || request?.to;
    if (!to || !/.+@.+\..+/.test(to)) throw new HttpsError('invalid-argument',
      'Pass a "to" address, e.g. sendTestInvoice({data: {to: "you@example.com"}}).');

    const snap = await fs.doc(STATE).get();
    const biz = { ...DEFAULT_BIZ, ...(snap.exists ? snap.data().meta?.biz || {} : {}) };
    const cfg = snap.exists ? snap.data().meta?.invoicing || {} : {};
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
        { id:'t5', dogId:'test_dog', date: day(1), session:'full', cancelled:true, cancelCharge:45 }
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
