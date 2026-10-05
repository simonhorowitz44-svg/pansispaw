/* Tests for invoice-core.js — run with: node invoice-core.test.mjs
 * This is money code that gets sent to clients without anyone reading it,
 * so every rule that decides an amount has a test here. */

import * as C from './invoice-core.js';

let pass = 0, fail = 0;
const t = (label, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ok   ' : '  FAIL ') + label); };
const eq = (label, a, b) => t(`${label}  (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

C.setPricing({ prices: {
  medium: { meet:0, trial:0, half:65, extended:80, full:100, overnight:115, scouts:75 },
  small:  { meet:0, trial:0, half:55, extended:70, full:80,  overnight:100, scouts:75 }
}});

const BIZ = { name:"Pansi's Paws Home Daycare", person:'Andressa Ubida', suburb:'Annandale, Sydney',
  phone:'0410 151 509', email:'a@x.com', site:'pansispaws.com.au',
  bsb:'062-000', acct:'12345678', abn:'12 345 678 901', stripeLink:'', bankDiscount:0 };

const base = () => ({
  meta: { billed:{}, invoicesSent:[], invoicing:{ goLive:'2026-09-01' } },
  owners: [
    { id:'own_kirsten_1', name:'Kirsten Lowe',  email:'k@x.com' },
    { id:'own_zoe_2',     name:'Zoe McLean',    email:'z@x.com' },
    { id:'own_bruna_3',   name:'Bruna Lowe',    email:'b@x.com' },
    { id:'own_noemail_4', name:'Siena Edwards' }
  ],
  dogs: [
    { id:'d1', ownerId:'own_kirsten_1', name:'Leo',    size:'medium' },
    { id:'d2', ownerId:'own_zoe_2',     name:'Stewie', size:'medium' },
    { id:'d3', ownerId:'own_bruna_3',   name:'Chico',  size:'medium' },
    { id:'d4', ownerId:'own_noemail_4', name:'Enzo',   size:'medium' }
  ],
  packs: [
    { id:'p1', dogId:'d1', size:10, daysUsed:9, expiryDate:'2026-12-14' },
    { id:'p2', dogId:'d2', size:5,  daysUsed:1, expiryDate:'2026-11-01' }
  ],
  bookings: []
});

/* ---------- week maths ---------- */
console.log('\nWeeks');
eq('a Wednesday belongs to the Sat–Fri week around it', C.weekOf('2026-09-16'), { from:'2026-09-12', to:'2026-09-18' });
eq('a Saturday starts its own week',                    C.weekOf('2026-09-12'), { from:'2026-09-12', to:'2026-09-18' });
eq('a Friday ends its week',                            C.weekOf('2026-09-18'), { from:'2026-09-12', to:'2026-09-18' });
t('consecutive weeks tile with no gap',
  C.addDaysISO(C.weekOf('2026-09-11').to, 1) === C.weekOf('2026-09-16').from);

/* ---------- the send trigger ---------- */
console.log('\nWhen a client\'s run is finished');
{
  const db = base();
  db.bookings = [
    { id:'b1', dogId:'d1', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' },
    { id:'b2', dogId:'d1', date:'2026-09-16', session:'full', total:100 }
  ];
  t('not finished while Wednesday is still open', !C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  db.bookings[1].departureLogged = '16:30';
  t('finished the moment Wednesday is collected — we do not wait for Friday',
    C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  db.bookings.push({ id:'b3', dogId:'d1', date:'2026-09-18', session:'full', total:100 });
  t('not finished again once a Friday booking exists', !C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  db.bookings[2].cancelled = true;
  t('a cancelled Friday does not hold the week open', C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
}
{
  const db = base();
  // Scouts runs don't get a departure logged; the date passing is what settles them.
  db.bookings = [{ id:'s1', dogId:'d1', date:'2026-09-14', session:'scouts', scoutsTrip:'am', total:75 }];
  t('a past Scouts adventure settles without a departure time',
    C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  t('today\'s Scouts adventure does not',
    !C.weekRunComplete(db, 'own_kirsten_1', '2026-09-14'));
}
{
  /* Was: nothing booked this week meant "not finished". That stranded anyone
     who stopped coming — their last visits never became an invoice, and the
     panel claimed they still had a booking due. Nothing pending means the run
     is done; whether there is anything to bill is buildInvoice's question. */
  const db = base();
  t('a client with nothing booked this week has finished their run',
    C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));

  /* The case that matters: they came last week, stopped, and the week rolled. */
  const gone = base();
  gone.bookings = [{ id:'last', dogId:'d1', date:'2026-09-11', session:'full', total:100, departureLogged:'16:00' }];
  t('a client who stopped coming can still be invoiced',
    C.weekRunComplete(gone, 'own_kirsten_1', '2026-09-23'));
  const inv = C.buildInvoice(gone, 'own_kirsten_1', { asAt:'2026-09-23', from:'2026-09-01' });
  eq('and their last visit is on it', inv.total, 100);
  eq('with nothing blocking it',      C.blockers(gone, inv, BIZ, '2026-09-23'), []);

  /* And it must not jump the gun on someone mid-week. */
  const midweek = base();
  midweek.bookings = [
    { id:'m1', dogId:'d1', date:'2026-09-21', session:'full', total:100, departureLogged:'16:00' },
    { id:'m2', dogId:'d1', date:'2026-09-24', session:'full', total:100 }
  ];
  t('someone with a visit still to come this week is not finished',
    !C.weekRunComplete(midweek, 'own_kirsten_1', '2026-09-22'));
}

/* ---------- what lands on the invoice ---------- */
console.log('\nInvoice lines');
const db = base();
db.bookings = [
  { id:'b1', dogId:'d1', date:'2026-09-14', session:'scouts', scoutsTrip:'am', total:75, departureLogged:'' },
  { id:'b2', dogId:'d1', date:'2026-09-15', session:'full', total:82.5, customPrice:82.5, departureLogged:'16:00' },
  { id:'b3', dogId:'d1', date:'2026-09-16', session:'full', packId:'p1', total:0, departureLogged:'16:00' },
  { id:'b4', dogId:'d1', date:'2026-09-17', session:'full', total:120, lateFee:20, departureLogged:'18:30' },
  { id:'b5', dogId:'d1', date:'2026-09-18', session:'full', total:50, cancelled:true, cancelCharge:50 },
  { id:'b6', dogId:'d1', date:'2026-09-18', session:'trial', total:0, departureLogged:'15:00' },
  { id:'b7', dogId:'d1', date:'2026-08-20', session:'full', packId:'p1', total:0, departureLogged:'16:00' },  // pack visit, before go-live
  { id:'b8', dogId:'d1', date:'2026-09-25', session:'full', total:100 },                            // in the future
  { id:'b9', dogId:'d2', date:'2026-09-15', session:'full', packId:'p2', total:0, departureLogged:'16:00' },
  { id:'b10', dogId:'d3', date:'2026-09-15', session:'overnight', total:115, departureLogged:'' },
  { id:'b11', dogId:'ghost', date:'2026-09-15', session:'full', total:40 }
];
const inv = C.buildInvoice(db, 'own_kirsten_1', { asAt:'2026-09-18' });
inv.lines.forEach(l => console.log(`      ${l.date}  ${l.dog.padEnd(4)} ${String(l.what).padEnd(24)} ${(l.note||'').padEnd(48)} $${l.amt.toFixed(2)}`));
console.log(`      TOTAL $${inv.total.toFixed(2)}   ${inv.number}   ref ${inv.ref}   due ${inv.dueISO}`);

t('lines sum exactly to the printed total',
  Math.abs(inv.lines.reduce((s,l) => s + l.amt, 0) - inv.total) < 1e-9);
eq('total is 75 + 82.50 + 0 + 100 + 20 + 50 + 0', inv.total, 327.5);
t('a price with cents survives', inv.lines.some(l => l.amt === 82.5));
t('the late fee is its own line', inv.lines.some(l => l.what === 'Late pickup' && l.amt === 20));
t('the day it happened on is billed whole, not net of the fee',
  inv.lines.some(l => l.date === '2026-09-17' && l.what === 'Full day' && l.amt === 100));
t('the late fee note is in plain English',
  inv.lines.some(l => /picked up at 6.30pm, 1 hour 30 minutes after 5pm/.test(l.note || '')));
t('a pack day is shown, numbered, and charged nothing',
  inv.lines.some(l => l.amt === 0 && /visit 2 of 10 on your pack/.test(l.note || '')));
eq('pack balance counts redemptions, not the running daysUsed', inv.packNotes[0].left, 8);
t('a short-notice cancellation is charged and explained',
  inv.lines.some(l => /Cancelled at short notice — 50%/.test(l.note || '')));
t('a free trial day is shown rather than hidden',
  inv.lines.some(l => l.what === 'Trial day' && l.amt === 0 && l.note === 'on us'));
t('nothing before the go-live date is billed', !inv.lines.some(l => l.date < '2026-09-01'));
t('nothing in the future is billed',          !inv.lines.some(l => l.date > '2026-09-18'));
eq('the period is the range actually billed', [inv.periodFrom, inv.periodTo], ['2026-09-14','2026-09-18']);

console.log('\nThings that must never reach a client');
const chico = C.buildInvoice(db, 'own_bruna_3', { asAt:'2026-09-18' });
t('an overnight stay is never labelled overnight', !/overnight/i.test(JSON.stringify(chico.lines)));
t('it reads as extended care instead', chico.lines.some(l => l.what === 'Extended care'));
const html = C.renderInvoiceHTML(inv, BIZ);
t('no internal instruction to Andressa appears on the document', !/Settings/i.test(html));
t('the document calls itself an Invoice', /inv-kind">Invoice</.test(html));
// Was: the invoice stated "No GST — not registered". Removed once turnover got
// close to the $75k threshold — a standing claim about tax status is a bad
// thing to leave on a document nobody re-reads. Silence is accurate either way
// until the accountant answers.
t('the invoice makes no claim about GST at all', !/GST/i.test(html));
t('payment terms are on it', /within 7 days/.test(html));
t('the pay block vanishes without bank details',
  !/inv-pay/.test(C.renderInvoiceHTML(inv, { ...BIZ, bsb:'', acct:'' })));

console.log('\nOrphans and identity');
eq('a booking whose dog is gone belongs to nobody',
  C.orphanBookings(db, '2026-09-01', '2026-09-18').map(b => b.id), ['b11']);
t('two clients called Lowe get different references',
  C.buildInvoice(db, 'own_bruna_3', { asAt:'2026-09-18' }).ref !== inv.ref);
{
  /* References are the dog's name now, at Andressa's request — she and the
     client both think in dogs, and ELVIS-0927 is recognised on a statement in
     a way BURKE-0927 is not. */
  const solo = base(); solo.bookings = [{ id:'x', dogId:'d4', date:'2026-09-15', session:'full', total:100, departureLogged:'16:00' }];
  eq('the reference is the dog, not the surname',
     C.buildInvoice(solo, 'own_noemail_4', { asAt:'2026-09-18' }).ref, 'ENZO-0918');

  /* Dog names are not unique: Loki and Simba each belong to three households
     in the real data. A shared name would make two clients' payments
     indistinguishable on the bank statement, so the surname goes back in. */
  const twins = base();
  twins.dogs.push({ id:'d5', ownerId:'own_zoe_2', name:'Enzo', size:'medium' });
  twins.bookings = [{ id:'y', dogId:'d4', date:'2026-09-15', session:'full', total:100, departureLogged:'16:00' }];
  eq('a shared dog name keeps the households apart',
     C.buildInvoice(twins, 'own_noemail_4', { asAt:'2026-09-18' }).ref, 'ENZO-EDWARDS-0918');

  /* A household with several dogs settles on one name rather than listing them. */
  const many = base();
  many.dogs.push({ id:'d6', ownerId:'own_kirsten_1', name:'Aggie', size:'medium' });
  many.bookings = [{ id:'z', dogId:'d1', date:'2026-09-15', session:'full', total:100, departureLogged:'16:00' }];
  eq('one reference per household',
     C.buildInvoice(many, 'own_kirsten_1', { asAt:'2026-09-18' }).ref, 'AGGIE-0918');

  /* And a client with no dog on file still gets something typeable. */
  const nodog = base();
  nodog.owners.push({ id:'own_nodog', name:'Sam Reilly', email:'s@x.com' });
  eq('no dog falls back to the surname', C.payRef(nodog, nodog.owners.find(o=>o.id==='own_nodog'), '2026-09-18'), 'REILLY-0918');
}

console.log('\nThe ledger stops double billing');
{
  const d2 = base();
  d2.bookings = [
    { id:'a', dogId:'d1', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' },
    { id:'b', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }
  ];
  const first = C.buildInvoice(d2, 'own_kirsten_1', { asAt:'2026-09-14' });
  eq('Monday alone bills $100', first.total, 100);
  first.bookingIds.forEach(id => { d2.meta.billed[id] = first.number; });
  d2.meta.invoicesSent.push({ ownerId:'own_kirsten_1', asAt:'2026-09-14', number:first.number });
  const second = C.buildInvoice(d2, 'own_kirsten_1', { asAt:'2026-09-16' });
  eq('Wednesday bills only the new day', second.total, 100);
  eq('and only the unbilled booking', second.bookingIds, ['b']);
  t('the second invoice has its own number', second.number !== first.number);
  d2.meta.billed['b'] = second.number;
  t('with everything billed there is nothing to invoice',
    C.buildInvoice(d2, 'own_kirsten_1', { asAt:'2026-09-18' }) === null);
}
{
  const d3 = base();
  d3.bookings = [{ id:'z', dogId:'d1', date:'2026-09-14', session:'full', total:100, cancelled:true, cancelCharge:0, departureLogged:'' }];
  const i = C.buildInvoice(d3, 'own_kirsten_1', { asAt:'2026-09-18' });
  t('a free cancellation produces no invoice at all', i === null);
}

console.log('\nWhat is safe to send unattended');
{
  const d4 = base();
  d4.bookings = [
    { id:'m1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' },
    { id:'m2', dogId:'d4', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' },
    { id:'m3', dogId:'d2', date:'2026-09-16', session:'full', packId:'p2', total:0, departureLogged:'16:00' },
    { id:'m4', dogId:'d3', date:'2026-09-16', session:'full', packId:'VANISHED', total:100, departureLogged:'16:00' },
    { id:'m5', dogId:'d3', date:'2026-09-18', session:'full', total:100 }
  ];
  const ok = C.sendableInvoices(d4, BIZ, { asAt:'2026-09-16' }).map(i => i.owner.id);
  eq('only the client with an email, no warnings and a finished week', ok, ['own_kirsten_1']);
  eq('no email address blocks it',
     C.blockers(d4, C.buildInvoice(d4,'own_noemail_4',{asAt:'2026-09-16'}), BIZ, '2026-09-16'),
     ['No email address for this client']);
  t('a pack-only week is a summary, not something to chase payment for',
     C.blockers(d4, C.buildInvoice(d4,'own_zoe_2',{asAt:'2026-09-16'}), BIZ, '2026-09-16')
      .some(x => /summary/.test(x)));
  t('a vanished pack holds the invoice back for a person',
     C.blockers(d4, C.buildInvoice(d4,'own_bruna_3',{asAt:'2026-09-16'}), BIZ, '2026-09-16')
      .some(x => /needs checking/.test(x)));
  t('missing bank details stop everything',
     C.sendableInvoices(d4, { ...BIZ, bsb:'' }, { asAt:'2026-09-16' }).length === 0);
}


/* ---------- the run, end to end, with a fake mailer ---------- */
console.log('\nA week of automatic sending');
{
  const d = base();
  d.meta.invoicing = { mode:'auto', goLive:'2026-09-01', batchCap:8 };
  d.bookings = [
    { id:'k1', dogId:'d1', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' },
    { id:'k2', dogId:'d1', date:'2026-09-16', session:'full', total:100 },
    { id:'z1', dogId:'d2', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' }
  ];
  const outbox = [];
  // Exactly what the Cloud Function does, minus the network and Firestore.
  const run = today => {
    const plan = C.planRun(d, BIZ, d.meta.invoicing, today);
    if (plan.skipped || plan.held) return plan;
    plan.jobs.forEach(inv => {
      outbox.push({ to: inv.owner.email, subject: C.invoiceSubject(inv, BIZ), total: inv.total });
      inv.bookingIds.forEach(id => { d.meta.billed[id] = inv.number; });
      d.meta.invoicesSent.push({ ownerId: inv.owner.id, asAt: inv.asAt, number: inv.number });
    });
    d.meta.sendQueue = [];
    return plan;
  };

  run('2026-09-14');
  eq('Monday night: only the client who is finished for the week is billed',
     outbox.map(x => x.to), ['z@x.com']);

  run('2026-09-14');
  eq('running again the same night sends nothing twice', outbox.length, 1);

  run('2026-09-15');
  eq('Tuesday: still nothing, Kirsten has Wednesday to come', outbox.length, 1);

  d.bookings[1].departureLogged = '16:20';
  run('2026-09-16');
  eq('Wednesday, the moment Leo is collected', outbox.map(x => x.to), ['z@x.com','k@x.com']);
  eq('and it covers both her days', outbox[1].total, 200);

  run('2026-09-18');
  eq('Friday sweep finds nothing left', outbox.length, 2);

  // A booking added after the invoice went out.
  d.bookings.push({ id:'k3', dogId:'d1', date:'2026-09-18', session:'full', total:100, departureLogged:'16:00' });
  run('2026-09-18');
  eq('a late addition gets its own invoice, not a correction', outbox.length, 3);
  eq('for the new day only', outbox[2].total, 100);
}

console.log('\nApproval mode and the safety rails');
{
  const d = base();
  d.meta.invoicing = { mode:'approve', goLive:'2026-09-01', batchCap:2 };
  d.bookings = [
    { id:'a1', dogId:'d1', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' },
    { id:'a2', dogId:'d2', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' }
  ];
  eq('nothing goes without approval, however finished the week is',
     C.planRun(d, BIZ, d.meta.invoicing, '2026-09-14').jobs.length, 0);

  d.meta.sendQueue = [{ ownerId:'own_kirsten_1', asAt:'2026-09-14', total:100 }];
  eq('an approved invoice goes', C.planRun(d, BIZ, d.meta.invoicing, '2026-09-14').jobs.map(i => i.owner.id), ['own_kirsten_1']);

  d.bookings.push({ id:'a3', dogId:'d1', date:'2026-09-14', session:'half', total:65, departureLogged:'16:00' });
  const p = C.planRun(d, BIZ, d.meta.invoicing, '2026-09-14');
  eq('a booking added after approval stops the send', p.jobs.length, 0);
  t('and says why', /changed after this was approved/.test(p.refused[0].why));

  const big = base();
  big.meta.invoicing = { mode:'auto', goLive:'2026-09-01', batchCap:2 };
  big.bookings = ['d1','d2','d3'].map((dog, i) =>
    ({ id:'g'+i, dogId:dog, date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' }));
  const held = C.planRun(big, BIZ, big.meta.invoicing, '2026-09-14');
  eq('an unusually large batch is held, not sent', held.jobs.length, 0);
  eq('and all of it is shown to a person', held.held.length, 3);

  eq('mode off does nothing at all', C.planRun(big, BIZ, { mode:'off' }, '2026-09-14').skipped, 'sending is off');
  eq('no bank details does nothing at all',
     C.planRun(big, { ...BIZ, acct:'' }, big.meta.invoicing, '2026-09-14').skipped, 'no bank details on file');
}

console.log('\nThe email');
{
  const d = base();
  d.bookings = [{ id:'e1', dogId:'d1', date:'2026-09-17', session:'full', total:120, lateFee:20, departureLogged:'18:30' }];
  const i = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-18' });
  const html = C.renderInvoiceEmail(i, BIZ);
  t('no CSS custom properties — email clients drop them', !/var\(--/.test(html));
  t('no external stylesheet or class hooks it depends on', !/<link|class="inv/.test(html));
  t('the logo is an absolute URL', /https:\/\/pansispaws\.com\.au\/images\/logo\.png/.test(html));
  t('it greets the client by name', /Hi Kirsten,/.test(html));
  t('the amount is in it', /\$100\.00/.test(html) && /\$20\.00/.test(html) && /\$120\.00/.test(html));
  t('bank details and reference are in it', /062-000/.test(html) && new RegExp(i.ref).test(html));
  t('the subject carries the number and amount', /invoice PP-.* · \$120\.00/.test(C.invoiceSubject(i, BIZ)));
  t('a client name with an ampersand cannot break the markup',
    C.renderInvoiceEmail({ ...i, owner:{ ...i.owner, name:'Ben & Jo <script>' } }, BIZ).includes('&amp;'));
}


console.log('\nDates must not drift with the timezone');
{
  /* toISOString() converts to UTC, so in Sydney it reports the previous day for
     any local midnight. Every date on an invoice has to come from addDaysISO. */
  const wrong = n => { const d = new Date('2026-09-17T00:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };
  const tzShifts = wrong(1) !== C.addDaysISO('2026-09-17', -1);
  eq('addDaysISO is stable whatever the timezone', C.addDaysISO('2026-09-17', -1), '2026-09-16');
  eq('a day forward',                              C.addDaysISO('2026-09-17',  1), '2026-09-18');
  eq('across a month boundary',                    C.addDaysISO('2026-09-30',  1), '2026-10-01');
  eq('across a year boundary',                     C.addDaysISO('2026-12-31',  1), '2027-01-01');
  eq('across a leap day',                          C.addDaysISO('2028-02-28',  1), '2028-02-29');
  eq('60 days out lands on the right day',         C.addDaysISO('2026-09-17', 60), '2026-11-16');
  console.log(`       (this machine is ${Intl.DateTimeFormat().resolvedOptions().timeZone}; ` +
              `toISOString ${tzShifts ? 'DOES' : 'does not'} shift here)`);
  eq('the due date is 7 days after the invoice date', C.addDaysISO('2026-09-17', C.INVOICE_TERMS_DAYS), '2026-09-24');
  eq('a Friday week still ends on the Friday', C.weekOf('2026-09-17').to, '2026-09-18');
}


console.log('\nThe run honours the config it is given');
{
  const d = base();
  d.meta.invoicing = { mode:'auto', batchCap:99, goLive:'2020-01-01' };  // db says bill everything
  d.bookings = [
    { id:'old', dogId:'d1', date:'2026-08-01', session:'full', total:100, departureLogged:'16:00' },
    { id:'new', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }
  ];
  const wide   = C.planRun(d, BIZ, { mode:'auto', batchCap:99, goLive:'2020-01-01' }, '2026-09-16');
  const narrow = C.planRun(d, BIZ, { mode:'auto', batchCap:99, goLive:'2026-09-01' }, '2026-09-16');
  eq('a wide go-live picks up the old visit too', wide.jobs[0].total, 200);
  eq("a narrow go-live in the caller's config is respected", narrow.jobs[0].total, 100);
  eq('and it is the recent visit that survives', narrow.jobs[0].lines[0].date, '2026-09-16');
}



console.log('\nThe account name reaches the client');
{
  /* Clients check the name before they send money — a transfer to the right
     BSB under an unexpected name is the thing that makes people stop and ring. */
  const d = base();
  d.bookings = [{ id:'n1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-16' });
  const named = { ...BIZ, acctName:'Andressa Fernandes' };

  t('the printed invoice names the account',  C.renderInvoiceHTML(inv, named).includes('Andressa Fernandes'));
  t('the email names the account',            C.renderInvoiceEmail(inv, named).includes('Andressa Fernandes'));
  t('the plain-text version names it too',    C.invoiceText(inv, named).includes('Account name: Andressa Fernandes'));

  t('the BSB survives alongside it',          C.renderInvoiceEmail(inv, named).includes('062-000'));
  t('and so does the account number',         C.renderInvoiceEmail(inv, named).includes('12345678'));

  /* Not every business has one saved yet, and a stray dash where a name should
     be looks worse than no name at all. */
  t('no name saved leaves no empty dash in the email', !C.renderInvoiceEmail(inv, BIZ).includes('</b> — <br>'));
  t('no name saved still shows the BSB',      C.renderInvoiceEmail(inv, BIZ).includes('062-000'));
  t('no name saved omits the text line',      !C.invoiceText(inv, BIZ).includes('Account name:'));

  /* A name is a nicety, not a routing detail — it must never block a send. */
  eq('a missing account name does not block sending', C.blockers(d, inv, BIZ, '2026-09-16').filter(x=>/name/i.test(x)), []);
}


console.log('\nA partial pricing.json must not make anything free');
{
  /* The live pricing.json only carries half, extended and full. setPricing used
     to replace the whole table, so scouts fell through calcTotal's `|| 0` and
     every Scouts Club booking invoiced at $0. Four real ones had already been
     saved that way. */
  const dog = { id:'dx', size:'medium' };
  const scouts = { id:'s1', dogId:'dx', date:'2026-09-21', session:'scouts', scoutsTrip:'am' };

  C.setPricing({ prices:{ medium:{ half:65, extended:80, full:90 } } });   // exactly what the file holds
  eq('scouts keeps its price when the file omits it', C.calcTotal(scouts, dog), 75);
  eq('a full day still takes the price from the file', C.calcTotal({ ...scouts, session:'full' }, dog), 90);
  eq('meet is still free',                            C.calcTotal({ ...scouts, session:'meet'  }, dog), 0);

  C.setPricing({ prices:{ medium:{ full:120 } } });
  eq('an override of one session wins',      C.calcTotal({ ...scouts, session:'full' }, dog), 120);
  eq('and leaves the others untouched',      C.calcTotal({ ...scouts, session:'half' }, dog), 65);
  eq('scouts survives a second partial load', C.calcTotal(scouts, dog), 75);

  /* A Scouts booking priced at zero vanishes from the invoice entirely, which is
     how this went unnoticed — no line, no warning, just a smaller total. */
  const d = base();
  d.dogs.push({ id:'dz', ownerId:'own_kirsten_1', name:'Scout', size:'medium' });
  d.bookings = [{ id:'sc1', dogId:'dz', date:'2026-09-16', session:'scouts', scoutsTrip:'am' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' });
  t('a Scouts booking reaches the invoice', inv.lines.some(l => /Scouts/i.test(l.what)));
  eq('and carries its price',               inv.total, 75);
}

// Restore the fixture pricing for anything that follows.
C.setPricing({ prices: {
  medium: { meet:0, trial:0, half:65, extended:80, full:100, overnight:115, scouts:75 },
  small:  { meet:0, trial:0, half:55, extended:70, full:80,  overnight:100, scouts:75 }
}});



console.log('\nAn open booking holds the whole client back, not just one dog');
{
  /* The rule people assume is per-dog. It is per-client: two dogs in one
     household get one invoice, so the later dog's booking has to hold it. */
  const db = base();
  db.dogs.push({ id:'d1b', ownerId:'own_kirsten_1', name:'Juno', size:'medium' });
  db.bookings = [
    { id:'k1', dogId:'d1',  date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' },
    { id:'k2', dogId:'d1b', date:'2026-09-18', session:'full', total:100 }
  ];
  t('Leo is home but Juno is booked Friday — not finished',
    !C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  t('and nothing is sendable for that client',
    !C.sendableInvoices(db, BIZ, { asAt:'2026-09-16' }).some(i => i.owner.id === 'own_kirsten_1'));

  db.bookings[1].departureLogged = '15:40';
  t('once Juno is collected the week is finished',
    C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  t('and the invoice becomes sendable',
    C.sendableInvoices(db, BIZ, { asAt:'2026-09-16' }).some(i => i.owner.id === 'own_kirsten_1'));
}

{
  /* One client's open booking must not hold a different client's invoice. */
  const db = base();
  db.bookings = [
    { id:'z1', dogId:'d2', date:'2026-09-14', session:'full', total:100, departureLogged:'16:00' },
    { id:'k9', dogId:'d1', date:'2026-09-18', session:'full', total:100 }
  ];
  t("Zoe's week is finished even though Kirsten is still coming Friday",
    C.weekRunComplete(db, 'own_zoe_2', '2026-09-16'));
  const s = C.sendableInvoices(db, BIZ, { asAt:'2026-09-16' }).map(i => i.owner.id);
  t('Zoe is sendable',          s.includes('own_zoe_2'));
  t('Kirsten is held back',    !s.includes('own_kirsten_1'));
}

{
  /* A visit Andressa forgot to tap "collected" on is in the past. If a stale
     row held the week open the client would never be invoiced at all, so the
     rule only looks forward. Worth knowing: it means a forgotten tap bills at
     the price saved before pickup, without any late fee. */
  const db = base();
  db.bookings = [
    { id:'f1', dogId:'d1', date:'2026-09-14', session:'full', total:100 },              // never collected
    { id:'f2', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }
  ];
  t('a past uncollected visit does not hold the week open forever',
    C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  eq('and it is still billed, at the pre-pickup price',
    C.buildInvoice(db, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' }).total, 200);
}

{
  /* Today counts as open. Someone collected at 4pm is finished; someone still
     here at 2pm is not — and the sweep runs at 7pm for exactly this reason. */
  const db = base();
  db.bookings = [{ id:'t1', dogId:'d1', date:'2026-09-16', session:'full', total:100 }];
  t("today's booking with no departure holds the week open",
    !C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
  db.bookings[0].departureLogged = '16:05';
  t('and releases it the moment they are collected',
    C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
}



console.log('\nApprove mode knows what is waiting on a person');
{
  /* The whole point of approve mode is that a person looks first. That only
     works if she is told there is something to look at — otherwise a finished
     invoice sits silently until someone thinks to open the panel. */
  const d = base();
  d.meta.invoicing = { mode:'approve', goLive:'2026-09-01', batchCap:8 };
  d.bookings = [
    { id:'w1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' },
    { id:'w2', dogId:'d2', date:'2026-09-16', session:'full', total:100, departureLogged:'16:10' }
  ];

  const ready = C.sendableInvoices(d, BIZ, { asAt:'2026-09-16', from:'2026-09-01' });
  eq('two clients are finished and billable', ready.length, 2);

  const plan = C.planRun(d, BIZ, d.meta.invoicing, '2026-09-16');
  eq('but approve mode sends none of them unprompted', plan.jobs.length, 0);

  const waiting = ready.filter(i => !(d.meta.sendQueue || []).some(q => q.ownerId === i.owner.id));
  eq('so both are waiting on her', waiting.length, 2);
  eq('and the nudge can total them', waiting.reduce((t,i)=>t+i.total,0), 200);

  d.meta.sendQueue = [{ ownerId:'own_kirsten_1', total:100 }];
  const after = C.planRun(d, BIZ, d.meta.invoicing, '2026-09-16');
  eq('approving one releases exactly one', after.jobs.length, 1);
  eq('and it is the one she approved', after.jobs[0].owner.id, 'own_kirsten_1');
  const stillWaiting = C.sendableInvoices(d, BIZ, { asAt:'2026-09-16', from:'2026-09-01' })
    .filter(i => !d.meta.sendQueue.some(q => q.ownerId === i.owner.id));
  eq('the other is still waiting, not forgotten', stillWaiting.length, 1);
}



console.log('\nThe invoice can leave the email address off');
{
  /* Her clients use WhatsApp, and an address on the invoice that nobody reads
     is worse than none — it bounces and looks careless. Phone only has to
     render cleanly, with no orphaned separator where the email used to be. */
  const d = base();
  d.bookings = [{ id:'p1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-16' });

  const noEmail = { ...BIZ, email:'', phone:'0410 151 509' };
  const email = C.renderInvoiceEmail(inv, noEmail);
  const print = C.renderInvoiceHTML(inv, noEmail);

  t('the phone still shows in the email',      email.includes('0410 151 509'));
  t('the phone still shows on the printout',   print.includes('0410 151 509'));
  t('no dangling separator in the email',     !/0410 151 509\s*·\s*</.test(email));
  t('no dangling separator on the printout',  !/0410 151 509\s*·\s*</.test(print));

  const withEmail = { ...BIZ, email:'hi@x.com', phone:'0410 151 509' };
  t('and it still appears when there is one',  C.renderInvoiceEmail(inv, withEmail).includes('hi@x.com'));
  t('separated from the phone',                C.renderInvoiceEmail(inv, withEmail).includes('0410 151 509 · hi@x.com'));

  /* Replies do not depend on it: reply-to is set on the message itself. */
  eq('a missing contact email never blocks a send', C.blockers(d, inv, noEmail, '2026-09-16'), []);
}



console.log('\nThe invoice says nothing about GST');
{
  /* Turnover is close to the $75k threshold and the answer is with an
     accountant. An invoice that volunteers "not registered" is a claim that
     could go stale without anyone noticing, so it says nothing either way.
     If she registers, this test should fail and be rewritten deliberately —
     a tax invoice has to show GST, it is not a line to quietly re-add. */
  const d = base();
  d.bookings = [{ id:'g1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-16' });

  t('the email mentions no GST either way',    !/GST/i.test(C.renderInvoiceEmail(inv, BIZ)));
  t('nor does the printed invoice',            !/GST/i.test(C.renderInvoiceHTML(inv, BIZ)));
  t('nor the plain-text version',              !/GST/i.test(C.invoiceText(inv, BIZ)));

  /* The rest of the footer has to survive its removal. */
  t('the payment terms are still there',        /7 days/.test(C.renderInvoiceHTML(inv, BIZ)));
  t('the cancellation terms are still there',   /Cancellations are free/.test(C.renderInvoiceHTML(inv, BIZ)));
  t('the ABN is still there',                   C.invoiceText(inv, BIZ).includes('12 345 678 901'));
}



console.log('\nEvery charge on the invoice is named, not folded in');
{
  /* Add-ons and surcharges used to be absorbed into the day rate, so four
     "Full day" lines could carry four different amounts with no explanation.
     The money was right; the document was not. */
  C.setPricing({ prices:{ medium:{ meet:0, trial:0, half:65, extended:80, full:90, scouts:75 } },
                 addons:{ senior:{amount:12}, puppy:{amount:12}, med:{amount:5},
                          diet:{amount:3}, taxi:{amount:35} },
                 surcharges:{ publicHoliday:{amount:25}, xmasPeakDay:{amount:15}, xmasPeakNight:{amount:30} } });

  const d = base();
  const put = b => { b.dogId = 'd1';
    b.total = C.calcTotal({ ...b, departureLogged:null }, d.dogs[0]);
    const L = C.latePickupFee(b); b.lateFee = L.fee; if (L.fee) b.total += L.fee;
    d.bookings.push(b); };

  d.bookings = [];
  put({ id:'x1', date:'2026-09-21', session:'full' });
  put({ id:'x2', date:'2026-09-22', session:'full', addOns:{ senior:true } });
  put({ id:'x3', date:'2026-09-23', session:'full', addOns:{ med:true, diet:true } });
  put({ id:'x4', date:'2026-09-24', session:'full', addOns:{ taxi:true } });
  put({ id:'x5', date:'2026-09-25', session:'half', addOns:{ senior:true, med:true }, departureLogged:'18:30' });
  put({ id:'x6', date:'2026-09-26', session:'full', surcharges:{ publicHoliday:true } });

  eq('a plain full day is the rate',            d.bookings[0].total, 90);
  eq('senior care is added at save time',       d.bookings[1].total, 102);
  eq('two small add-ons stack',                 d.bookings[2].total, 98);
  eq('transport is the dear one',               d.bookings[3].total, 125);
  eq('add-ons and a late pickup together',      d.bookings[4].total, 102);
  eq('a public holiday surcharge',              d.bookings[5].total, 115);

  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-01' });
  const day = inv.lines.filter(l => l.what === 'Full day').map(l => l.amt);
  eq('every full day now reads the same rate',  [...new Set(day)], [90]);

  const named = n => inv.lines.some(l => l.what === n);
  t('senior care is named',        named('Senior care'));
  t('medication is named',         named('Medication'));
  t('special diet is named',       named('Special diet'));
  t('transport is named',          named('Pickup & drop-off'));
  t('the public holiday is named', named('Public holiday'));
  t('late pickup is still named',  named('Late pickup'));

  eq('and the total is untouched by naming them', inv.total, 632);
  eq('the lines add up to the total',
     inv.lines.reduce((t2,l)=>t2+Math.round(l.amt*100),0)/100, inv.total);
}

{
  /* Cases where a breakdown would be wrong or misleading. */
  const d = base();
  d.bookings = [
    { id:'c1', dogId:'d1', date:'2026-09-21', session:'full', customPrice:70,
      addOns:{ senior:true }, total:70, departureLogged:'16:00' },
    { id:'c2', dogId:'d1', date:'2026-09-22', session:'scouts', scoutsTrip:'am',
      addOns:{ taxi:true }, total:75 },
    { id:'c3', dogId:'d1', date:'2026-09-23', session:'full', cancelled:true, cancelCharge:45,
      addOns:{ senior:true } }
  ];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-01' });

  t('a hand-typed price is not broken apart',   !inv.lines.some(l => l.what === 'Senior care' && l.date === '2026-09-21'));
  eq('and it bills exactly what she typed',      inv.lines.find(l => l.date === '2026-09-21').amt, 70);
  t('Scouts has transport in the rate already', !inv.lines.some(l => l.date === '2026-09-22' && l.what === 'Pickup & drop-off'));
  t('a cancelled day charges no add-ons',       !inv.lines.some(l => l.date === '2026-09-23' && l.what === 'Senior care'));
  eq('just the cancellation charge',             inv.lines.filter(l => l.date === '2026-09-23').length, 1);
  eq('the whole thing still reconciles',         inv.total, 190);
}

// Back to the fixture pricing for anything after this.
C.setPricing({ prices: {
  medium: { meet:0, trial:0, half:65, extended:80, full:100, overnight:115, scouts:75 },
  small:  { meet:0, trial:0, half:55, extended:70, full:80,  overnight:100, scouts:75 }
}});



console.log('\nA run without a go-live date bills nothing');
{
  /* Found in an end-to-end audit before launch. goLive defaults to '' in the
     panel. buildInvoice falls back to year zero, so the first automatic run
     would bill a client's entire history in one email — and the batch cap
     counts invoices, not visits, so one client with 34 old bookings passes
     straight through it. */
  const d = base();
  d.bookings = [
    { id:'old1', dogId:'d1', date:'2024-01-10', session:'full', total:100, departureLogged:'16:00' },
    { id:'old2', dogId:'d1', date:'2025-06-02', session:'full', total:100, departureLogged:'16:00' },
    { id:'new1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }
  ];

  const blank = C.planRun(d, BIZ, { mode:'auto', batchCap:8, goLive:'' }, '2026-09-16');
  eq('a blank go-live sends nothing',        blank.jobs.length, 0);
  eq('and says why',                          blank.skipped, 'no go-live date set');

  const missing = C.planRun(d, BIZ, { mode:'auto', batchCap:8 }, '2026-09-16');
  eq('a missing go-live is refused too',      missing.jobs.length, 0);

  const set = C.planRun(d, BIZ, { mode:'auto', batchCap:8, goLive:'2026-09-01' }, '2026-09-16');
  eq('with a date it runs',                   set.jobs.length, 1);
  eq('and bills only what is inside it',      set.jobs[0].total, 100);
  eq('one line, not three years',             set.jobs[0].lines.length, 1);
}



console.log('\nThe late pickup cap is a day, not a dog');
{
  /* terms.html and services.html both publish "capped at $40 a day". The cap
     was applied per booking, so a household collecting three dogs late once
     was charged $120 against a published maximum of $40. */
  const d = base();
  d.dogs.push({ id:'d1b', ownerId:'own_kirsten_1', name:'Juno', size:'medium' });
  d.dogs.push({ id:'d1c', ownerId:'own_kirsten_1', name:'Pip',  size:'medium' });
  const late = (id, dogId) => ({ id, dogId, date:'2026-09-16', session:'full',
                                 total:100, departureLogged:'20:00' });
  d.bookings = [late('l1','d1'), late('l2','d1b'), late('l3','d1c')];

  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' });
  const lateTotal = inv.lines.filter(l => l.what === 'Late pickup')
                             .reduce((t, l) => t + l.amt, 0);
  eq('three dogs, one late collection, one cap', lateTotal, C.LATE_CAP);
  eq('and the day still bills all three',        inv.lines.filter(l => l.what === 'Full day').length, 3);
  eq('total is three days plus one cap',         inv.total, 300 + C.LATE_CAP);
  eq('one late line for one collection, not three',
     inv.lines.filter(l => l.what === 'Late pickup').length, 1);

  /* Where a fee is only partly charged because the day is nearly capped, say
     so — otherwise the arithmetic looks wrong to anyone checking it. */
  const mixed = base();
  mixed.dogs.push({ id:'d1b', ownerId:'own_kirsten_1', name:'Juno', size:'medium' });
  mixed.bookings = [
    { id:'p1', dogId:'d1',  date:'2026-09-16', session:'full', total:100, departureLogged:'18:30' },
    { id:'p2', dogId:'d1b', date:'2026-09-16', session:'full', total:100, departureLogged:'20:00' }
  ];
  const mx = C.buildInvoice(mixed, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' });
  eq('the day still stops at the cap',
     mx.lines.filter(l => l.what === 'Late pickup').reduce((t,l)=>t+l.amt,0), C.LATE_CAP);
  t('and the truncated one explains itself',
    mx.lines.some(l => /capped at \$40 for the day/.test(l.note || '')));

  /* A different day gets its own cap — this is per date, not per invoice. */
  d.bookings.push({ id:'l4', dogId:'d1', date:'2026-09-17', session:'full', total:100, departureLogged:'20:00' });
  const two = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-17', from:'2026-09-01' });
  eq('two late days, two caps',
     two.lines.filter(l => l.what === 'Late pickup').reduce((t,l)=>t+l.amt,0), C.LATE_CAP * 2);

  /* And one dog collected a little late is unaffected by any of this. */
  const one = base();
  one.bookings = [{ id:'s1', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'18:30' }];
  const inv1 = C.buildInvoice(one, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' });
  eq('a single hour late is still just the fee',
     inv1.lines.find(l => l.what === 'Late pickup').amt, 20);
  t('and says nothing about a cap',
    !/capped/.test(inv1.lines.find(l => l.what === 'Late pickup').note || ''));

  eq('lines still sum to the total',
     inv.lines.reduce((t,l)=>t+Math.round(l.amt*100),0)/100, inv.total);
}



console.log('\nAn ad-hoc charge explains itself');
{
  /* Boarding has check-in and check-out times but no published fee structure
     yet. Rather than inflating the nightly rate — which leaves the client
     reading a number that does not match what they were quoted — an extra is
     its own line with Andressa's own wording. */
  const d = base();
  d.bookings = [{ id:'e1', dogId:'d1', date:'2026-09-16', session:'full', total:100,
                  departureLogged:'16:00', extraCharge:40, extraNote:'Extended hours' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' });

  eq('the day is still the day',        inv.lines.find(l => l.what === 'Full day').amt, 100);
  eq('the extra is its own line',       inv.lines.find(l => l.what === 'Extended hours').amt, 40);
  eq('and the total is both',           inv.total, 140);
  eq('lines sum to the total',          inv.lines.reduce((t,l)=>t+Math.round(l.amt*100),0)/100, inv.total);

  const unnamed = base();
  unnamed.bookings = [{ id:'e2', dogId:'d1', date:'2026-09-16', session:'full', total:100,
                        departureLogged:'16:00', extraCharge:15 }];
  const u = C.buildInvoice(unnamed, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' });
  eq('an unlabelled extra on a daycare day says something', u.lines.find(l => l.amt === 15).what, 'Additional charge');

  const none = base();
  none.bookings = [{ id:'e3', dogId:'d1', date:'2026-09-16', session:'full', total:100, departureLogged:'16:00' }];
  eq('and nothing appears when there is no extra',
     C.buildInvoice(none, 'own_kirsten_1', { asAt:'2026-09-16', from:'2026-09-01' }).lines.length, 1);
}


console.log('\nAn old booking can be billed one at a time');
{
  /* The go-live date stops the first run billing months of history. But a
     single old visit that genuinely was not paid still needs a way onto an
     invoice — and the answer must not be moving the date, which would sweep in
     every client's backlog at once. */
  const d = base();
  d.bookings = [
    { id:'aug', dogId:'d1', date:'2026-08-13', session:'half', total:75, departureLogged:'15:00' },
    { id:'sep', dogId:'d1', date:'2026-09-24', session:'half', total:75, departureLogged:'15:00' }
  ];

  const normal = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' });
  eq('the old visit is left off by default', normal.total, 75);
  eq('one line only',                        normal.lines.length, 1);

  d.bookings[0].billAnyway = true;
  const opted = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' });
  eq('ticked, it joins the invoice',         opted.total, 150);
  eq('as its own dated line',                opted.lines.length, 2);
  eq('with its real date, not a moved one',  opted.lines[0].date, '2026-08-13');

  /* The ledger still applies: billed once, never again. */
  d.meta.billed = { aug:'PP-OLD' };
  eq('and once billed it stays billed',
     C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' }).total, 75);

  /* It must not become a back door round the go-live guard. */
  const noDate = C.planRun(d, BIZ, { mode:'auto', batchCap:8, goLive:'' }, '2026-09-27');
  eq('a blank go-live still refuses everything', noDate.jobs.length, 0);
}



console.log('\nBoarding has check-in and check-out hours');
{
  /* Never written down anywhere, so it lived in Andressa's head and got priced
     from memory — one large dog charged $95, $130 and $155 in a fortnight. The
     window is 3pm to 10am; outside it uses the daycare rule clients already
     know: 15 minutes' grace, $10 a half hour, $40 a day. */
  const f = b => C.boardingHoursFee(b).fee;

  eq('on time costs nothing',        f({ session:'overnight', arrivalTime:'15:00', departureLogged:'10:00' }), 0);
  eq('ten minutes either side is grace',
                                     f({ session:'overnight', arrivalTime:'14:50', departureLogged:'10:10' }), 0);
  eq('ninety minutes late out',      f({ session:'overnight', departureLogged:'11:30' }), 30);
  eq('three hours early in caps',    f({ session:'overnight', arrivalTime:'12:00' }), C.LATE_CAP);
  eq('both ends share one daily cap',
                                     f({ session:'overnight', arrivalTime:'12:00', departureLogged:'11:30' }), C.LATE_CAP);

  t('and it says which end',         /before 3pm/.test(C.boardingHoursFee({ session:'overnight', arrivalTime:'12:00' }).why));
  t('and the other end',             /after 10am/.test(C.boardingHoursFee({ session:'overnight', departureLogged:'11:30' }).why));

  /* It must not reach across into daycare, which has its own 5.30pm rule. */
  eq('a daycare booking is untouched',
     f({ session:'full', departureLogged:'19:00' }), 0);
  eq('a cancelled stay owes nothing',
     f({ session:'overnight', cancelled:true, arrivalTime:'12:00', departureLogged:'11:30' }), 0);
  eq('and a waiver clears it',
     f({ session:'overnight', lateFeeWaived:true, arrivalTime:'12:00' }), 0);

  /* This used to be offered and charged only if Andressa accepted it, which
     meant in practice it was never charged. The hours are recorded, the rule is
     published and the arithmetic is fixed, so it bills itself now. No
     customPrice here on purpose — a negotiated all-in stay is exempt, and that
     is covered by its own test further down. */
  const d = base();
  d.bookings = [{ id:'st', dogId:'d1', date:'2026-09-26', session:'overnight',
                  total:130, arrivalTime:'12:00', departureLogged:'11:30' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' });
  eq('the hours bill themselves on top of the night', inv.total, 170);
  t('as a line that explains itself',
    inv.lines.some(l => l.what === 'Outside check-in hours' && /before 3pm/.test(l.note || '')));
}



console.log('\nA stay is charged by one rule, not two');
{
  /* Overnight was subject to the daycare 5.30pm cutoff as well as its own 10am
     checkout, so a dog collected at 6pm the day after was billed for the same
     lateness twice — $10 under one rule and $40 under the other. */
  const late = { session:'overnight', arrivalTime:'15:00', departureLogged:'18:00' };
  eq('the daycare rule stays out of boarding', C.latePickupFee(late).fee, 0);
  eq('boarding charges it once',               C.boardingHoursFee(late).fee, C.LATE_CAP);

  /* And a morning collection is measured against checkout, not the evening. */
  const morning = { session:'overnight', arrivalTime:'15:00', departureLogged:'11:30' };
  eq('90 minutes past 10am',                   C.boardingHoursFee(morning).fee, 30);
  eq('and nothing from the daycare cutoff',    C.latePickupFee(morning).fee, 0);

  /* Daycare itself is untouched. */
  eq('a daycare dog at 6.30pm still pays',     C.latePickupFee({ session:'full', departureLogged:'18:30' }).fee, 20);
  eq('and at 8pm still caps',                  C.latePickupFee({ session:'full', departureLogged:'20:00' }).fee, C.LATE_CAP);

  /* calcTotal must not quietly add the old fee to a stay either. */
  const dog = { id:'d1', size:'medium' };
  C.setPricing({ prices:{ medium:{ meet:0, trial:0, half:65, extended:80, full:90, overnight:115, scouts:75 } } });
  eq('an overnight price is the rate, nothing bolted on',
     C.calcTotal({ session:'overnight', departureLogged:'18:00' }, dog), 115);
}



console.log('\nA stay shows when it started and ended');
{
  /* Boarding is the one line a client cannot check from memory: a night and an
     extra-hours charge, with nothing saying which night or which hours. */
  const d = base();
  d.dogs[0].size = 'medium';
  d.bookings = [{ id:'s1', dogId:'d1', date:'2026-09-26', session:'overnight',
                  total:115, customPrice:115, arrivalTime:'13:00', departureLogged:'11:30',
                  extraCharge:40, extraNote:'Extended hours' }];
  const inv = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' });

  const stay = inv.lines.find(l => l.what === 'Extended care');
  t('the drop-off time is on it',   /dropped 1pm/.test(stay.note));
  t('so is the collection',         /collected 11.30am/.test(stay.note));
  t('and that it was the next day', /next day/.test(stay.note));

  eq('the night comes first',       inv.lines[0].what, 'Extended care');
  eq('then what it cost extra',     inv.lines[1].what, 'Extended hours');
  eq('and it still adds up',        inv.total, 155);

  /* One end only, which is what a middle night of a long stay looks like. */
  const partial = base();
  partial.bookings = [{ id:'s2', dogId:'d1', date:'2026-09-26', session:'overnight',
                        total:115, customPrice:115, departureLogged:'11:30' }];
  t('collection alone still reads',
    /collected 11.30am next day/.test(C.buildInvoice(partial, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' }).lines[0].note));

  const none = base();
  none.bookings = [{ id:'s3', dogId:'d1', date:'2026-09-26', session:'overnight', total:115, customPrice:115 }];
  /* No times, so nothing to say about the stay — but the price was hand-typed,
     and a hand-typed price now always says at least that it was agreed. */
  eq('no times leaves only the price explanation',
     C.buildInvoice(none, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' }).lines[0].note, 'agreed rate');

  /* Daycare keeps its own note; this must not leak across. */
  const day = base();
  day.bookings = [{ id:'s4', dogId:'d1', date:'2026-09-26', session:'full', total:100, departureLogged:'16:00' }];
  eq('a daycare day says nothing about next day',
     C.buildInvoice(day, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' }).lines[0].note, '');
}



console.log('\nAn unexplained charge explains itself');
{
  /* "Additional charge $40" and nothing else is the line most likely to be
     queried, and the worst one to leave bare. On a stay the times are already
     recorded, so the invoice can say what they were without Andressa typing
     anything. */
  const stay = n => {
    const d = base(); d.dogs[0].size = 'medium';
    d.bookings = [{ id:'x', dogId:'d1', date:'2026-09-26', session:'overnight', total:115,
                    customPrice:115, arrivalTime:'13:00', departureTime:'11:30',
                    extraCharge:40, extraNote:n }];
    return C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' })
            .lines.find(l => l.amt === 40);
  };

  const bare = stay('');
  eq('it names itself when she has not',  bare.what, 'Outside check-in hours');
  t('and says which hours',               /before 3pm/.test(bare.note) && /after 10am/.test(bare.note));

  const hers = stay('Extended hours');
  eq('her own wording still wins',        hers.what, 'Extended hours');
  t('and keeps the explanation',          /before 3pm/.test(hers.note));

  /* A charge with no times behind it has nothing to explain, so it stays plain
     rather than inventing a reason. */
  const d2 = base();
  d2.bookings = [{ id:'y', dogId:'d1', date:'2026-09-26', session:'full', total:100,
                   departureLogged:'16:00', extraCharge:25, extraNote:'' }];
  const plain = C.buildInvoice(d2, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' })
                 .lines.find(l => l.amt === 25);
  eq('a daycare extra stays generic',     plain.what, 'Additional charge');
  eq('with nothing made up',              plain.note, '');
}



console.log('\nThe cap says when it bit');
{
  /* Two hours early plus ninety minutes late is $60 of half-hour blocks, billed
     at $40. Without saying so the client reads a number that does not follow
     from the hours above it. */
  const elvis = { session:'overnight', arrivalTime:'13:00', departureTime:'11:30' };
  const r = C.boardingHoursFee(elvis);
  eq('charged at the cap',        r.fee, C.LATE_CAP);
  eq('though the hours came to more', r.uncapped, 60);
  t('and the line says so',       /capped at \$40/.test(r.why));

  /* Under the cap, no mention — nothing was reduced, so saying "capped" would
     be noise at best and misleading at worst. */
  const small = C.boardingHoursFee({ session:'overnight', departureTime:'11:30' });
  eq('a smaller overrun is charged in full', small.fee, 30);
  t('with no talk of a cap',                !/capped/.test(small.why));

  /* Exactly on the cap is not a reduction either. */
  const exact = C.boardingHoursFee({ session:'overnight', departureTime:'12:15' });
  eq('landing exactly on it',    exact.fee, C.LATE_CAP);
  t('still says nothing',       !/capped/.test(exact.why));

  /* And it reaches the invoice. */
  const d = base(); d.dogs[0].size = 'medium';
  d.bookings = [{ id:'z', dogId:'d1', date:'2026-09-26', session:'overnight', total:115,
                  customPrice:115, arrivalTime:'13:00', departureTime:'11:30', extraCharge:40 }];
  const line = C.buildInvoice(d, 'own_kirsten_1', { asAt:'2026-09-27', from:'2026-09-21' })
                .lines.find(l => l.amt === 40);
  t('the client sees the cap on the invoice', /capped at \$40/.test(line.note));
}



/* ------------------------------------------------------------------ *
 * Boarding hours bill themselves                                      *
 * ------------------------------------------------------------------ */
console.log('\nA stay outside its window charges itself');
{
  const db = {
    owners:[{ id:'o1', name:'Mike O’Shea', email:'m@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Greg', size:'medium' }],
    bookings:[], packs:[], meta:{ invoicing:{ goLive:'2026-01-01' } }
  };
  const base = { id:'b1', dogId:'d1', date:'2026-09-26', session:'overnight' };

  db.bookings = [{ ...base, arrivalLogged:'13:00', departureLogged:'11:30' }];
  let inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  const line = inv.lines.find(l => l.what === 'Outside check-in hours');
  t('the charge appears with nobody typing it', !!line);
  eq('and it is the capped amount', line.amt, 40);
  t('the note says what happened',
    /arrived 2 hours before 3pm/.test(line.note || '') && /collected 1 hour 30 minutes after 10am/.test(line.note || ''));
  t('and that the cap bit', /capped at \$40/.test(line.note || ''));

  /* Times typed into the booking rather than tapped on the day bill the same. */
  db.bookings = [{ ...base, arrivalTime:'13:00', departureTime:'11:30' }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  t('typed times charge the same as tapped ones',
    inv.lines.some(l => l.what === 'Outside check-in hours' && l.amt === 40));

  /* A hand-typed charge is an override, not an addition. */
  db.bookings = [{ ...base, arrivalLogged:'13:00', departureLogged:'11:30',
                   extraCharge:25, extraNote:'Agreed early drop' }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  const manual = inv.lines.filter(l => /Outside check-in hours|Agreed early drop/.test(l.what));
  eq('a typed charge replaces the automatic one, never doubles it', manual.length, 1);
  eq('and it is the typed amount that bills', manual[0].amt, 25);
  eq('under her own wording', manual[0].what, 'Agreed early drop');

  /* Waiving still waives. */
  db.bookings = [{ ...base, arrivalLogged:'13:00', departureLogged:'11:30', lateFeeWaived:true }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  t('a waived stay charges nothing', !inv.lines.some(l => l.what === 'Outside check-in hours'));

  /* A negotiated all-in price is not re-opened by the clock. */
  db.bookings = [{ ...base, arrivalLogged:'13:00', departureLogged:'11:30', customPrice:600 }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  t('a custom-priced stay is left alone',
    !inv.lines.some(l => l.what === 'Outside check-in hours'));
  eq('and bills only what was agreed', inv.total, 600);

  /* But she can still add to one by hand. */
  db.bookings = [{ ...base, arrivalLogged:'13:00', departureLogged:'11:30',
                   customPrice:600, extraCharge:40, extraNote:'Extra night hours' }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  eq('a hand-typed charge still lands on a custom stay', inv.total, 640);

  /* On time is on time. */
  db.bookings = [{ ...base, arrivalLogged:'15:10', departureLogged:'10:10' }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  t('inside the grace charges nothing', !inv.lines.some(l => l.what === 'Outside check-in hours'));

  /* Daycare is not boarding. */
  db.bookings = [{ ...base, session:'full', arrivalTime:'07:30', departureTime:'09:00' }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  t('a daycare day never gets a check-in charge',
    !inv.lines.some(l => l.what === 'Outside check-in hours'));
}


console.log('\nThe things that used to bill zero in silence');
{
  const db = {
    owners:[{ id:'o1', name:'Shy Virk', email:'s@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Lola', size:'small' },
          { id:'d2', ownerId:'o1', name:'Sizeless' }],
    bookings:[], packs:[], meta:{ invoicing:{ goLive:'2026-01-01' } }
  };

  /* A hand-typed price arriving as a string used to concatenate: '85' + 10
     invoiced as 8510. */
  eq('a string custom price is a number', C.calcTotal({ session:'full', customPrice:'85' }, db.dogs[0]), 85);
  eq('and still takes the late fee on top',
     C.calcTotal({ session:'full', customPrice:'85', departureLogged:'18:30' }, db.dogs[0]), 105);

  /* A redeemed day is stored total:0. When its pack vanished, the stored zero
     won and the day produced no line at all — never charged, never billed,
     warning every run forever. */
  db.bookings = [{ id:'b1', dogId:'d1', date:'2026-09-29', session:'full', packId:'GONE',
                   total:0, customPrice:0 }];
  let inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-30' });
  t('a day on a vanished pack still produces an invoice', !!inv);
  eq('priced at the normal rate, not zero', inv && inv.total, 80);
  t('and says so', inv && inv.warnings.some(w => /pack that no longer exists/.test(w)));
  t('and is marked billed so it stops coming back', inv && inv.bookingIds.includes('b1'));
  t('which puts it in front of a human first',
    C.blockers(db, inv, { bsb:'1', acct:'2' }, '2026-09-30').length > 0);

  /* No size, no rate, no noise — three dogs on file have none. */
  db.bookings = [{ id:'b2', dogId:'d2', date:'2026-09-29', session:'full' }];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-30' });
  t('a dog with no size warns rather than billing nothing quietly',
    inv && inv.warnings.some(w => /no size on file/.test(w)));
}


console.log('\nOne cap a day, however the hours were used');
{
  const db = {
    owners:[{ id:'o1', name:'One Household', email:'h@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Greg',  size:'medium' },
          { id:'d2', ownerId:'o1', name:'Pookster', size:'large' }],
    bookings:[], packs:[], meta:{ invoicing:{ goLive:'2026-01-01' } }
  };

  /* Two dogs of one household, both dropped three hours early on the same day.
     Each used to carry its own $40 cap. */
  db.bookings = [
    { id:'s1', dogId:'d1', date:'2026-09-26', session:'overnight', arrivalLogged:'12:00' },
    { id:'s2', dogId:'d2', date:'2026-09-26', session:'overnight', arrivalLogged:'12:00' }
  ];
  let inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  let hours = inv.lines.filter(l => l.what === 'Outside check-in hours');
  eq('the day caps at $40 across both dogs', hours.reduce((t,l) => t + l.amt, 0), C.LATE_CAP);
  eq('the first stay takes the whole cap, so the second adds no line', hours.length, 1);

  /* When the first stay only uses part of the cap, the second is trimmed to
     what is left and says so. */
  db.bookings = [
    { id:'s1', dogId:'d1', date:'2026-09-26', session:'overnight', arrivalLogged:'14:00' },
    { id:'s2', dogId:'d2', date:'2026-09-26', session:'overnight', arrivalLogged:'12:00' }
  ];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  hours = inv.lines.filter(l => l.what === 'Outside check-in hours');
  eq('a partly-used cap leaves room for the second', hours.length, 2);
  eq('and the two together still stop at $40', hours.reduce((t,l) => t + l.amt, 0), C.LATE_CAP);
  t('with the trimmed one saying the cap bit',
    hours.some(l => /capped at \$40 for the day/.test(l.note || '')));

  /* A late pickup and a check-in charge on one date share the same ceiling. */
  db.bookings = [
    { id:'s3', dogId:'d1', date:'2026-09-26', session:'overnight', arrivalLogged:'12:00' },
    { id:'s4', dogId:'d2', date:'2026-09-26', session:'full', departureLogged:'19:30' }
  ];
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  eq('a late pickup and a check-in charge share one cap',
     inv.lines.filter(l => /Outside check-in hours|Late pickup/.test(l.what))
              .reduce((t,l) => t + l.amt, 0), C.LATE_CAP);
}

console.log('\nA pack stops working when it runs out of time');
{
  const db = {
    owners:[{ id:'o1', name:'Shy Virk', email:'s@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Lola', size:'small' }],
    packs:[{ id:'p1', dogId:'d1', size:10, daysUsed:2, purchaseDate:'2026-03-01', expiryDate:'2026-09-01' }],
    bookings:[{ id:'b1', dogId:'d1', date:'2026-09-29', session:'full', packId:'p1', total:0, customPrice:0 }],
    meta:{ invoicing:{ goLive:'2026-01-01' } }
  };
  const inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-30' });
  eq('a day taken off an expired pack is charged', inv.total, 80);
  t('and says which pack and when it ran out',
    inv.warnings.some(w => /expired 2026-09-01/.test(w)));
  eq('and the pack shows nothing left after the expiry',
     C.packLeftAsAt(db, db.packs[0], '2026-09-30'), 0);
  eq('though it still showed its days before it', C.packLeftAsAt(db, db.packs[0], '2026-08-01'), 10);
}


console.log('\nThe check-in charge explains itself to the client');
{
  const db = {
    owners:[{ id:'o1', name:'Mike', email:'m@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Greg', size:'medium' }],
    packs:[], meta:{ invoicing:{ goLive:'2026-01-01' } },
    bookings:[{ id:'s1', dogId:'d1', date:'2026-09-26', session:'overnight',
                arrivalLogged:'13:00', departureLogged:'11:30' }]
  };
  const inv = C.buildInvoice(db, 'o1', { asAt:'2026-09-27' });
  const biz = { person:'Andressa', site:'pansispaws.com.au', bsb:'1', acct:'2' };
  const html = C.renderInvoiceEmail(inv, biz);
  const text = C.invoiceText(inv, biz);
  t('the email says what the charge is for',
    /Arrival before 3pm or collection after 10am is \$10 per 30 minutes/.test(html));
  t('and names the grace and the cap', /15 minute grace period/.test(html) && /capped at \$40 a day/.test(html));
  t('the plain text version says it too',
    /Arrival before 3pm or collection after 10am/.test(text));
  t('and it never calls it boarding', !/boarding/i.test(html));
}


console.log('\nA line that explains its own price');
{
  const db = {
    owners:[{ id:'o1', name:'Shy Virk', email:'s@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Lola', size:'small' }],
    packs:[], meta:{ invoicing:{ goLive:'2026-01-01' } }, bookings:[]
  };
  const day = extra => ({ id:'b1', dogId:'d1', date:'2026-09-29', session:'full', ...extra });
  const line = () => C.buildInvoice(db, 'o1', { asAt:'2026-09-30' }).lines[0];

  db.bookings = [day({ customPrice:59, customPriceNote:'old rate, with us since July' })];
  eq('a hand-typed price says what was agreed', line().note, 'old rate, with us since July');

  db.bookings = [day({ customPrice:59 })];
  eq('and says it was agreed even when nobody wrote why', line().note, 'agreed rate');

  db.bookings = [day({})];
  eq('an ordinary day stays quiet', line().note, '');

  /* Working notes stay internal unless she says otherwise. */
  db.bookings = [day({ notes:'upset tummy, called Shy' })];
  eq('a note is not published by default', line().note, '');

  db.bookings = [day({ notes:'stayed late for the vet run', noteOnInvoice:true })];
  eq('and is published when she ticks it', line().note, 'stayed late for the vet run');

  db.bookings = [day({ notes:'agreed on the phone', noteOnInvoice:true, customPrice:59, customPriceNote:'old rate' })];
  eq('her words come first, then the price reason',
     line().note, 'agreed on the phone · old rate');

  /* A stay still says when it started and ended, after the rest. */
  db.bookings = [day({ session:'overnight', arrivalTime:'15:00', departureTime:'10:00',
                       customPrice:130, customPriceNote:'long stay rate' })];
  t('a stay keeps its times last',
    /^long stay rate · dropped 3pm, collected 10am next day$/.test(line().note));
}


console.log('\nEvery charged line says what it is');
{
  const db = {
    owners:[{ id:'o1', name:'Emma', email:'e@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Celine', size:'small' }],
    packs:[], meta:{ invoicing:{ goLive:'2026-01-01' } },
    bookings:[{ id:'b1', dogId:'d1', date:'2026-10-05', session:'full',
                addOns:{ med:true, taxi:true },
                surcharges:{ publicHoliday:true } }]
  };
  const inv = C.buildInvoice(db, 'o1', { asAt:'2026-10-06' });
  const noteFor = what => (inv.lines.find(l => l.what === what) || {}).note;

  eq('medication says what it is and the rate', noteFor('Medication'), 'giving medication, per visit · $5');
  eq('transport too', noteFor('Pickup & drop-off'), 'collected from home and dropped back, per trip · $35');
  eq('and the holiday surcharge names the holiday', noteFor('Public holiday'), 'NSW public holiday · $25');
  t('no line is left bare', inv.lines.filter(l => l.amt > 0).every(l => l.what === 'Full day' || l.note));

  /* The rate in the sentence comes from the constant, so it cannot describe a
     price that has since changed. */
  const was = C.ADDONS.med;
  C.setPricing({ addons: { med: { amount: 7 } } });
  const inv2 = C.buildInvoice(db, 'o1', { asAt:'2026-10-06' });
  t('and follows a price change', /\$7$/.test((inv2.lines.find(l => l.what === 'Medication') || {}).note || ''));
  C.setPricing({ addons: { med: { amount: was } } });
}


console.log('\nA stay held with a deposit');
{
  const mk = () => ({
    owners:[{ id:'o1', name:'Mike O\u2019Shea', email:'m@x.com' }],
    dogs:[{ id:'d1', ownerId:'o1', name:'Greg', size:'medium' }],
    packs:[], deposits:[], meta:{ invoicing:{ goLive:'2026-01-01' } },
    bookings:[
      { id:'n1', dogId:'d1', date:'2026-10-01', session:'overnight' },
      { id:'n2', dogId:'d1', date:'2026-10-02', session:'overnight' },
      { id:'n3', dogId:'d1', date:'2026-10-03', session:'overnight' }
    ]
  });

  const db = mk();
  eq('half of three medium nights, rounded',
     C.depositDue(db.bookings, db.dogs[0]), Math.round(115 * 3 * 0.5));

  /* Recorded but not yet received: the invoice is untouched. */
  db.deposits = [{ id:'dep1', dogId:'d1', bookingIds:['n1','n2','n3'], amount:173, paidAt:null }];
  let inv = C.buildInvoice(db, 'o1', { asAt:'2026-10-04' });
  eq('an unpaid deposit changes nothing', inv.total, 345);
  t('and puts no line on the invoice', !inv.lines.some(l => l.credit));

  /* Paid: the full stay is still billed, then the money comes back off. */
  db.deposits[0].paidAt = '2026-09-20T00:00:00.000Z';
  db.deposits[0].paidAmount = 173;
  inv = C.buildInvoice(db, 'o1', { asAt:'2026-10-04' });
  const credit = inv.lines.find(l => l.credit);
  t('a paid deposit appears as its own line', !!credit);
  eq('as a credit, not a discount', credit.amt, -173);
  t('saying when it was received', /received/.test(credit.note || ''));
  eq('the nights are still billed in full',
     inv.lines.filter(l => !l.credit).reduce((t,l) => t + l.amt, 0), 345);
  eq('and the balance is what is left', inv.total, 172);

  /* Once only, however many nights it covered. */
  eq('credited once, not once a night', inv.lines.filter(l => l.credit).length, 1);

  /* And it has to read like a credit, not like a typo. */
  const biz = { person:'Andressa', site:'pansispaws.com.au', name:"Pansi's Paws", bsb:'1', acct:'2' };
  const txt = C.invoiceText(inv, biz);
  t('the text version shows a minus, not $-', /-\$173\.00/.test(txt) && !/\$-/.test(txt));
  t('and does not leave a stray separator where the dog would be', !/ {2}· Deposit/.test(txt));
  t('the email shows a true minus sign', /\u2212\$173\.00/.test(C.renderInvoiceEmail(inv, biz)));

  /* A deposit larger than the bill cannot hand money back on an invoice. */
  const big = mk();
  big.bookings = [big.bookings[0]];
  big.deposits = [{ id:'dep2', dogId:'d1', bookingIds:['n1'], amount:300,
                    paidAt:'2026-09-20T00:00:00.000Z', paidAmount:300 }];
  const inv2 = C.buildInvoice(big, 'o1', { asAt:'2026-10-04' });
  eq('the invoice stops at nothing owed', inv2.total, 0);
  t('and says what is still theirs',
    inv2.warnings.some(w => /is still theirs/.test(w)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
