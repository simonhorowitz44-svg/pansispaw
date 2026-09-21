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
  const db = base();
  t('a client with nothing booked this week is not "finished"',
    !C.weekRunComplete(db, 'own_kirsten_1', '2026-09-16'));
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
  inv.lines.some(l => /picked up at 6.30pm, 1 hour after 5.30pm/.test(l.note || '')));
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
t('GST status is stated so nobody assumes it is included', /No GST — not registered/.test(html));
t('payment terms are on it', /within 7 days/.test(html));
t('the pay block vanishes without bank details',
  !/inv-pay/.test(C.renderInvoiceHTML(inv, { ...BIZ, bsb:'', acct:'' })));

console.log('\nOrphans and identity');
eq('a booking whose dog is gone belongs to nobody',
  C.orphanBookings(db, '2026-09-01', '2026-09-18').map(b => b.id), ['b11']);
t('two clients called Lowe get different references',
  C.buildInvoice(db, 'own_bruna_3', { asAt:'2026-09-18' }).ref !== inv.ref);
{
  const solo = base(); solo.bookings = [{ id:'x', dogId:'d4', date:'2026-09-15', session:'full', total:100, departureLogged:'16:00' }];
  eq('a client with no namesake keeps a clean reference',
     C.buildInvoice(solo, 'own_noemail_4', { asAt:'2026-09-18' }).ref, 'EDWARDS-0918');
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


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
