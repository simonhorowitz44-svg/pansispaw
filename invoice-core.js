/* Pansi's Paws — pricing, policy and invoice generation.
 *
 * This file is the single source of truth for what a client is charged. Both the
 * admin panel and the Cloud Function that sends invoices import it, so an invoice
 * sent while nobody is watching is priced by exactly the same code Andressa sees
 * on screen. Don't copy anything out of here into either caller.
 *
 * Everything is pure: pass the database in, get numbers out. Nothing reads the
 * DOM, nothing writes to Firestore.
 */

/* ---------- pricing (mutable — pricing.json overrides at runtime) ---------- */

export let PRICES = {
  small:  { meet:0, trial:0, half:55, extended:70, full:80,  overnight:100, scouts:75 },
  medium: { meet:0, trial:0, half:65, extended:80, full:90,  overnight:115, scouts:75 },
  large:  { meet:0, trial:0, half:75, extended:90, full:100, overnight:130, scouts:75 }
};
export let ADDONS     = { senior:12, puppy:12, med:5, diet:3, taxi:35 };
export let SURCHARGES = { publicHoliday:25, xmasPeakDay:15, xmasPeakNight:30 };

/* Accepts the shape of pricing.json, or plain {prices, addons, surcharges}. */
export function setPricing(p) {
  if (!p) return;
  if (p.prices) PRICES = p.prices;
  if (p.addons) ADDONS = {
    senior: p.addons.senior?.amount ?? p.addons.senior ?? ADDONS.senior,
    puppy:  p.addons.puppy?.amount  ?? p.addons.puppy  ?? ADDONS.puppy,
    med:    p.addons.med?.amount    ?? p.addons.med    ?? ADDONS.med,
    diet:   p.addons.diet?.amount   ?? p.addons.diet   ?? ADDONS.diet,
    taxi:   p.addons.taxi?.amount   ?? p.addons.taxi   ?? ADDONS.taxi
  };
  if (p.surcharges) SURCHARGES = {
    publicHoliday: p.surcharges.publicHoliday?.amount ?? p.surcharges.publicHoliday ?? SURCHARGES.publicHoliday,
    xmasPeakDay:   p.surcharges.xmasPeakDay?.amount   ?? p.surcharges.xmasPeakDay   ?? SURCHARGES.xmasPeakDay,
    xmasPeakNight: p.surcharges.xmasPeakNight?.amount ?? p.surcharges.xmasPeakNight ?? SURCHARGES.xmasPeakNight
  };
}

/* ---------- policy ---------- */

export const SESSION_LABELS = { meet:"Meet & greet", trial:"Trial day", half:"Half day",
  extended:"Extended half", full:"Full day", overnight:"Overnight", scouts:"Scouts adventure" };
export const SCOUTS_TRIPS = { am:{ label:"Morning · from 7:30", start:"07:30" },
                              pm:{ label:"Afternoon · from 1:30", start:"13:30" } };

// Late pickup. Published on services.html: after 5:30pm, $10 per 30 minutes,
// 15-minute grace, capped at $40 a day. Change here and on the site together.
export const LATE_CUTOFF    = '17:30';
export const LATE_GRACE_MIN = 15;
export const LATE_PER_30    = 10;
export const LATE_CAP       = 40;

// Cancellation. 24h+ notice is free; inside 24h is charged at this rate.
// Mirrored in terms.html §7 — change both together.
export const CANCEL_NOTICE_HOURS = 24;
export const CANCEL_CHARGE_RATE  = 0.5;

export const INVOICE_TERMS_DAYS = 7;

/* ---------- small helpers ---------- */

export const localISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export const escapeHtml = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* Money is held in cents while we add up, so lines always sum to the total. */
export const cents = n => Math.round(Number(n || 0) * 100);

export function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localISO(d);
}
export function weekEndingFriday(d) {
  const x = new Date(d); x.setHours(0,0,0,0);
  x.setDate(x.getDate() + ((5 - x.getDay() + 7) % 7));   // forward to Friday
  return x;
}
export function invoiceWeek(fridayISO) {
  return { from: addDaysISO(fridayISO, -6), to: fridayISO };
}
/* The week a date sits in, Saturday through Friday. */
export function weekOf(isoDate) {
  return invoiceWeek(localISO(weekEndingFriday(new Date(isoDate + 'T00:00:00'))));
}
/* 5.30pm reads better than 17:30 on a document a dog owner reads. */
export function friendlyTime(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (isNaN(h)) return hhmm || '';
  const ampm = h < 12 ? 'am' : 'pm';
  const h12  = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}.${String(m).padStart(2,'0')}${ampm}` : `${h12}${ampm}`;
}
export function friendlyMins(mins) {
  if (mins < 60) return `${mins} minutes`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} hour${h===1?'':'s'}${m ? ` ${m} minutes` : ''}`;
}
export const fmtDay   = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short' });
export const fmtDayY  = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
export const fmtDayWk = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' });

/* ---------- lookups ---------- */

export const dogById   = (db, id) => (db.dogs   || []).find(d => d.id === id);
export const ownerById = (db, id) => (db.owners || []).find(o => o.id === id);
export function ownerOf(db, dogId) {
  const d = dogById(db, dogId);
  return d ? ownerById(db, d.ownerId) : undefined;
}

/* ---------- money ---------- */

export function latePickupFee(b) {
  const none = { minsLate: 0, fee: 0, blocks: 0 };
  if (!b || b.lateFeeWaived || b.cancelled) return none;
  if (b.session === 'meet' || b.session === 'trial' || b.session === 'scouts') return none;
  const t = b.departureLogged;
  if (!t || t.length < 4) return none;
  const toMin = x => { const p = String(x).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };
  const minsLate = toMin(t) - toMin(LATE_CUTOFF);
  if (minsLate <= LATE_GRACE_MIN) return none;
  const blocks = Math.ceil((minsLate - LATE_GRACE_MIN) / 30);
  return { minsLate, blocks, fee: Math.min(blocks * LATE_PER_30, LATE_CAP) };
}

export function calcTotal(booking, dog) {
  if (booking.cancelled) return booking.cancelCharge || 0;
  if (booking.session === 'meet' || booking.session === 'trial') return 0;
  const late = latePickupFee(booking).fee;
  if (booking.customPrice != null) return booking.customPrice + late;
  if (!dog) return late;
  let t = PRICES[dog.size]?.[booking.session] || 0;
  // Scouts is a flat rate with transport included — daycare add-ons don't apply.
  if (booking.session === 'scouts') return t;
  if (booking.addOns?.senior) t += ADDONS.senior;
  if (booking.addOns?.puppy)  t += ADDONS.puppy;
  if (booking.addOns?.med)    t += ADDONS.med;
  if (booking.addOns?.diet)   t += ADDONS.diet;
  if (booking.addOns?.taxi)   t += ADDONS.taxi;
  if (booking.surcharges?.publicHoliday) t += SURCHARGES.publicHoliday;
  if (booking.surcharges?.xmasPeak) t += (booking.session === 'overnight' ? SURCHARGES.xmasPeakNight : SURCHARGES.xmasPeakDay);
  return t + late;
}

/* ---------- packs ---------- */

/* The pack's redemptions, oldest first. daysUsed is a running counter that
   includes bookings that haven't happened yet, so it can't number a visit. */
export function packRedemptions(db, pack) {
  return (db.bookings || [])
    .filter(x => x.packId === pack.id && !x.cancelled)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
}
export function packVisitNumber(db, pack, booking) {
  const i = packRedemptions(db, pack).findIndex(x => x.id === booking.id);
  return i < 0 ? 0 : Math.min(i + 1, pack.size);
}
/* Visits left as at a date — so a reprinted invoice says what it said then. */
export function packLeftAsAt(db, pack, isoDate) {
  return Math.max(0, pack.size - packRedemptions(db, pack).filter(x => x.date <= isoDate).length);
}

/* ---------- identity ---------- */

export function surnameTag(owner) {
  const words = String(owner.name || '').trim().split(/\s+/).filter(Boolean);
  const surname = words.length ? words[words.length - 1] : '';
  return surname.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'CLIENT';
}
/* Surname alone, unless someone else shares it — then three characters of the
   id to keep them apart. Short references get typed correctly more often. */
export function ownerTag(db, owner) {
  const tag = surnameTag(owner);
  const shared = (db.owners || []).some(o => o.id !== owner.id && surnameTag(o) === tag);
  return shared ? `${tag}${String(owner.id).replace(/[^A-Za-z0-9]/g, '').slice(-3).toUpperCase()}` : tag;
}
export function payRef(db, owner, asAtISO) {
  return `${ownerTag(db, owner)}-${asAtISO.slice(5,7)}${asAtISO.slice(8,10)}`;
}
export function invoiceNumber(owner, asAtISO, seq) {
  const base = `PP-${asAtISO.replace(/-/g, '')}-${String(owner.id).replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase()}`;
  return seq > 1 ? `${base}-${seq}` : base;
}

/* What a client is allowed to see. Overnight stays are history the council has
   since closed off — they must never appear as a service on a document. */
export function invoiceLabel(session) {
  return session === 'overnight' ? 'Extended care' : (SESSION_LABELS[session] || session);
}

/* ---------- the ledger of what has already been billed ---------- */

export const billedMap = db => (db.meta && db.meta.billed) || {};
export const isBilled  = (db, bookingId) => !!billedMap(db)[bookingId];

/* How many invoices this owner has already had. Keeps invoice numbers unique
   when a second run in the same day produces a second invoice. */
export function invoiceSeq(db, ownerId, asAtISO) {
  const sent = (db.meta && db.meta.invoicesSent) || [];
  return sent.filter(s => s.ownerId === ownerId && s.asAt === asAtISO).length + 1;
}

/* ---------- is this client's run finished? ---------- */

/* True when nothing is left in the client's current week: every booking from
   today onwards in this Sat–Fri week is either departed or cancelled. This is
   the trigger — we don't wait for Friday if their last day was Tuesday. */
export function weekRunComplete(db, ownerId, todayISO) {
  const { from, to } = weekOf(todayISO);
  const mine = (db.bookings || []).filter(b =>
    b.date >= from && b.date <= to && ownerOf(db, b.dogId)?.id === ownerId);
  if (!mine.length) return false;
  return !mine.some(b =>
    b.date >= todayISO && !b.cancelled && !b.departureLogged);
}

/* ---------- building the invoice ---------- */

/* Everything billable that hasn't been billed yet.
   opts: { asAt = today, from = meta.invoicingGoLive, includeBilled = false } */
export function buildInvoice(db, ownerId, opts = {}) {
  const owner = ownerById(db, ownerId); if (!owner) return null;
  const asAt  = opts.asAt || localISO(new Date());
  const floor = opts.from || (db.meta && db.meta.invoicing && db.meta.invoicing.goLive) || '0000-01-01';
  const lines = [], packNotes = [], warnings = [], bookingIds = [];
  let totalC = 0;
  const push = (o, amt, b) => { lines.push({ ...o, amt: amt / 100 }); totalC += amt; if (b && !bookingIds.includes(b.id)) bookingIds.push(b.id); };

  (db.bookings || [])
    .filter(b => b.date >= floor && b.date <= asAt)
    .filter(b => opts.includeBilled || !isBilled(db, b.id))
    .filter(b => ownerOf(db, b.dogId)?.id === ownerId)
    .sort((a,b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)))
    .forEach(b => {
      const dog     = dogById(db, b.dogId);
      const dogName = dog ? dog.name : 'Your dog';
      const label   = invoiceLabel(b.session);
      const trip    = b.session === 'scouts' && b.scoutsTrip && SCOUTS_TRIPS[b.scoutsTrip]
                    ? ' · ' + SCOUTS_TRIPS[b.scoutsTrip].label.split('·')[0].trim() : '';

      if (b.cancelled) {
        const amt = cents(b.cancelCharge);
        if (!amt) { bookingIds.push(b.id); return; }   // free cancellation: billed, nothing owed
        const full = calcTotal({ ...b, cancelled:false, departureLogged:null }, dog);
        const pct  = full ? Math.round((b.cancelCharge / full) * 100) : 0;
        push({ date:b.date, dog:dogName, what:`${label} — cancelled`,
               note: pct ? `Cancelled at short notice — ${pct}% of the day's rate` : 'Cancellation charge' }, amt, b);
        return;
      }

      const L = latePickupFee(b);
      const addLate = () => {
        if (!L.fee) return;
        push({ date:b.date, dog:dogName, what:'Late pickup',
               note:`picked up at ${friendlyTime(b.departureLogged)}, ${friendlyMins(L.minsLate)} after ${friendlyTime(LATE_CUTOFF)}` },
             cents(L.fee), b);
      };

      if (b.packId) {
        const pk = (db.packs || []).find(p => p.id === b.packId);
        if (!pk) {
          warnings.push(`${dogName}'s visit on ${b.date} points at a pack that no longer exists — billed at the normal rate.`);
        } else {
          const n = packVisitNumber(db, pk, b);
          push({ date:b.date, dog:dogName, what:`${label}${trip}`,
                 note: n ? `visit ${n} of ${pk.size} on your pack` : 'on your pack', pack:true }, 0, b);
          if (!packNotes.some(x => x.id === pk.id)) {
            packNotes.push({ id:pk.id, dog:dogName, left: packLeftAsAt(db, pk, asAt), size: pk.size, expires: pk.expiryDate });
          }
          addLate();
          return;
        }
      }

      // b.total is written by calcTotal at save time. departDog records b.lateFee
      // alongside it, so we know exactly how much of it is the fee. Older rows
      // have no lateFee — for those, a stored total equal to the current price
      // plus the fee is the only case where the fee is already baked in.
      const priced = calcTotal({ ...b, departureLogged:null }, dog);
      let baseC;
      if (b.total == null)          baseC = cents(priced);
      else if (b.lateFee != null)   baseC = cents(b.total) - cents(b.lateFee);
      else                          baseC = cents(b.total) === cents(priced + L.fee) ? cents(b.total) - cents(L.fee) : cents(b.total);
      if (baseC < 0) baseC = 0;

      if (baseC || b.session === 'meet' || b.session === 'trial') {
        push({ date:b.date, dog:dogName, what:`${label}${trip}`,
               note: baseC ? '' : 'on us', free: !baseC }, baseC, b);
      }
      addLate();
    });

  if (!lines.length) return null;
  const total = totalC / 100;
  const dates = lines.map(l => l.date).sort();
  const seq   = opts.seq || invoiceSeq(db, ownerId, asAt);
  return {
    owner, asAt, bookingIds, lines, packNotes, warnings,
    periodFrom: dates[0], periodTo: dates[dates.length - 1],
    total, ref: payRef(db, owner, asAt), number: invoiceNumber(owner, asAt, seq),
    dueISO: addDaysISO(asAt, INVOICE_TERMS_DAYS),
    nothingDue: total <= 0
  };
}

/* Bookings in range that belong to nobody — the dog or owner record is gone.
   They can't reach an invoice, so they'd go unbilled without a flag. */
export function orphanBookings(db, fromISO, toISO) {
  return (db.bookings || []).filter(b =>
    b.date >= fromISO && b.date <= toISO && !ownerOf(db, b.dogId));
}

/* Every client with something ready to bill, biggest first. */
export function invoicesDue(db, opts = {}) {
  return (db.owners || [])
    .map(o => buildInvoice(db, o.id, opts))
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);
}

/* Which of those are safe to send without anyone looking. */
export function sendableInvoices(db, biz, opts = {}) {
  const asAt = opts.asAt || localISO(new Date());
  return invoicesDue(db, opts).filter(inv =>
    !inv.nothingDue &&
    !inv.warnings.length &&
    !!inv.owner.email &&
    weekRunComplete(db, inv.owner.id, asAt) &&
    !!(biz && biz.bsb && biz.acct));
}

/* Why an invoice isn't going out. Empty array means it is. */
export function blockers(db, inv, biz, asAt) {
  const out = [];
  if (!biz || !biz.bsb || !biz.acct) out.push('No bank details on file');
  if (!inv.owner.email)              out.push('No email address for this client');
  if (inv.warnings.length)           out.push(inv.warnings.length + ' line needs checking');
  if (inv.nothingDue)                out.push('Nothing to pay — this is a summary, not an invoice');
  if (!weekRunComplete(db, inv.owner.id, asAt || localISO(new Date())))
                                     out.push('Still has a booking to come this week');
  return out;
}

/* ---------- rendering ---------- */

export function renderInvoiceHTML(inv, biz, o = {}) {
  const m = n => '$' + Number(n).toFixed(2);
  const bank = biz.bsb && biz.acct;
  const bankOff = bank && biz.bankDiscount > 0 ? biz.bankDiscount : 0;
  const isInv = !inv.nothingDue;
  const period = inv.periodFrom === inv.periodTo
    ? fmtDayY(inv.periodTo)
    : `${fmtDay(inv.periodFrom)} – ${fmtDayY(inv.periodTo)}`;
  const logo = o.logoSrc || 'images/logo.png';

  return `<div class="inv" id="invSheet">
    <div class="inv-head">
      <img class="inv-logo" src="${logo}" alt="Pansi's Paws">
      <div class="inv-biz">
        <div class="inv-biz-name">${escapeHtml(biz.name)}</div>
        <div>${escapeHtml(biz.suburb)}</div>
        <div>${escapeHtml(biz.phone)} · ${escapeHtml(biz.email)}</div>
        ${biz.abn ? `<div>ABN ${escapeHtml(biz.abn)}</div>` : ''}
      </div>
      <div class="inv-kind">${isInv ? 'Invoice' : 'Summary'}</div>
    </div>

    <div class="inv-meta">
      <div><span>${isInv ? 'Invoice for' : 'Summary for'}</span><b>${escapeHtml(inv.owner.name)}</b></div>
      <div><span>Covering</span><b>${period}</b></div>
      ${isInv ? `<div><span>Invoice no.</span><b>${escapeHtml(inv.number)}</b></div>
      <div><span>Due</span><b>${fmtDayY(inv.dueISO)}</b></div>` : ''}
    </div>

    <table class="inv-table">
      <thead><tr><th>Date</th><th>Dog</th><th>Service</th><th class="r">Amount</th></tr></thead>
      <tbody>
        ${inv.lines.map(l => `<tr class="${l.pack || l.free ? 'pack' : ''}">
          <td>${fmtDay(l.date)}</td>
          <td>${escapeHtml(l.dog)}</td>
          <td>${escapeHtml(l.what)}${l.note ? `<span class="inv-note">${escapeHtml(l.note)}</span>` : ''}</td>
          <td class="r">${l.amt ? m(l.amt) : '—'}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="3">${isInv ? 'Total due' : 'Nothing to pay'}</td>
        <td class="r">${m(inv.total)}</td></tr></tfoot>
    </table>

    ${inv.packNotes.map(p => `<div class="inv-pack">
      <b>${escapeHtml(p.dog)}'s pack</b> — ${p.left} of ${p.size} visit${p.left===1?'':'s'} still to use${p.expires ? `, up to ${fmtDayWk(p.expires)}` : ''}.
    </div>`).join('')}

    ${isInv && bank ? `<div class="inv-pay">
      <div class="inv-pay-title">How to pay · within ${INVOICE_TERMS_DAYS} days</div>
      <div class="inv-pay-row"><b>Bank transfer</b> — BSB ${escapeHtml(biz.bsb)} · Account ${escapeHtml(biz.acct)}<br>
        Please use the reference <b>${escapeHtml(inv.ref)}</b> so we can match your payment.${
        bankOff ? `<br>Pay this way and it's <b>${m(inv.total - bankOff)}</b> — $${bankOff} off.` : ''}</div>
      ${biz.stripeLink ? `<div class="inv-pay-row"><b>Card</b> — <a href="${escapeHtml(biz.stripeLink)}">pay online here</a>.</div>` : ''}
    </div>` : ''}

    <div class="inv-foot">
      Thank you — ${escapeHtml(biz.person)} 🐾 · ${escapeHtml(biz.site)}<br>
      <span>${isInv ? `Payment within ${INVOICE_TERMS_DAYS} days. ` : ''}No GST — not registered.
      Cancellations are free with more than 24 hours' notice, and half the day's rate inside 24 hours.${
        inv.lines.some(l => l.what === 'Late pickup')
          ? ` Pickup after ${friendlyTime(LATE_CUTOFF)} is $${LATE_PER_30} per 30 minutes once a ${LATE_GRACE_MIN} minute grace period has passed, capped at $${LATE_CAP} a day.` : ''}</span>
    </div>
  </div>`;
}

/* Plain text, for WhatsApp or an email body. Mirrors the printed one. */
export function invoiceText(inv, biz) {
  const first = String(inv.owner.name || '').trim().split(/\s+/)[0] || 'there';
  const period = inv.periodFrom === inv.periodTo
    ? fmtDayY(inv.periodTo) : `${fmtDay(inv.periodFrom)} – ${fmtDayY(inv.periodTo)}`;
  const L = [`Hi ${first},`, ''];
  L.push(inv.nothingDue
    ? `Here's a summary of your time with us, ${period}.`
    : `Here's your invoice for ${period}.`);
  L.push('');
  inv.lines.forEach(l => L.push(
    `${fmtDay(l.date)}  ${l.dog} · ${l.what}${l.note ? ' (' + l.note + ')' : ''}  ${l.amt ? '$' + l.amt.toFixed(2) : '—'}`));
  L.push('');
  L.push(inv.nothingDue ? 'Nothing to pay.' : `Total due: $${inv.total.toFixed(2)} by ${fmtDayY(inv.dueISO)}`);
  inv.packNotes.forEach(p => L.push(`${p.dog}'s pack — ${p.left} of ${p.size} still to use${p.expires ? ', up to ' + fmtDayWk(p.expires) : ''}.`));
  if (!inv.nothingDue && biz.bsb && biz.acct) {
    L.push('', 'How to pay', `Bank transfer: BSB ${biz.bsb}, Account ${biz.acct}`, `Reference: ${inv.ref}`);
    if (biz.stripeLink) L.push(`Or by card: ${biz.stripeLink}`);
  }
  L.push('', `Thank you — ${biz.person} 🐾`, biz.name + (biz.abn ? ` · ABN ${biz.abn}` : ''), 'No GST — not registered.');
  return L.join('\n');
}

/* ---------- email ---------- */

/* Email clients don't do custom properties, half of them strip <style>, and a
   few still want tables. So the email is built with inline styles and literal
   colours rather than reusing the panel's stylesheet. The numbers come from the
   same buildInvoice, which is the part that must not diverge. */
export function renderInvoiceEmail(inv, biz, o = {}) {
  const m = n => '$' + Number(n).toFixed(2);
  const ink = '#3f2814', ink2 = '#6b5641', ink3 = '#93826d';
  const edge = '#e6dcc8', kraft = '#f6efdd', paper = '#faf6ed';
  const bank = biz.bsb && biz.acct;
  const isInv = !inv.nothingDue;
  const first = String(inv.owner.name || '').trim().split(/\s+/)[0] || 'there';
  const period = inv.periodFrom === inv.periodTo
    ? fmtDayY(inv.periodTo) : `${fmtDay(inv.periodFrom)} – ${fmtDayY(inv.periodTo)}`;
  const logo = o.logoUrl || 'https://pansispaws.com.au/images/logo.png';
  const logoW = o.logoWidth || 84;
  const cell = `padding:9px 8px 9px 0;border-bottom:1px solid ${edge};color:${ink2};font-size:14px;vertical-align:top`;

  const rows = inv.lines.map(l => `<tr>
    <td style="${cell};white-space:nowrap">${fmtDay(l.date)}</td>
    <td style="${cell}">${escapeHtml(l.dog)}</td>
    <td style="${cell}">${escapeHtml(l.what)}${l.note ? `<div style="font-size:12px;color:${ink3};margin-top:2px">${escapeHtml(l.note)}</div>` : ''}</td>
    <td style="${cell};text-align:right;white-space:nowrap">${l.amt ? m(l.amt) : '—'}</td></tr>`).join('');

  return `<!doctype html><html><body style="margin:0;padding:0;background:${paper}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${paper};padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${edge};border-radius:10px;padding:26px 24px;font-family:Georgia,'Times New Roman',serif">

  <tr><td style="padding-bottom:16px;border-bottom:2px solid ${edge}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="${logoW + 12}" style="vertical-align:middle"><img src="${logo}" width="${logoW}" alt="Pansi's Paws" style="display:block;width:${logoW}px;height:auto"></td>
      <td style="vertical-align:middle;font-family:Helvetica,Arial,sans-serif">
        <div style="font-size:17px;color:${ink};font-weight:bold;font-family:Georgia,serif">${escapeHtml(biz.name)}</div>
        <div style="font-size:12px;color:${ink2};line-height:1.5">${escapeHtml(biz.suburb)}<br>
        ${escapeHtml(biz.phone)} · ${escapeHtml(biz.email)}${biz.abn ? `<br>ABN ${escapeHtml(biz.abn)}` : ''}</div></td>
      <td align="right" style="vertical-align:top;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${ink3}">${isInv ? 'Invoice' : 'Summary'}</td>
    </tr></table></td></tr>

  <tr><td style="padding:18px 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:${ink2};line-height:1.6">
    Hi ${escapeHtml(first)},<br>
    ${isInv ? `Here's your invoice for ${period}.` : `Here's a summary of your time with us, ${period}.`}
  </td></tr>

  ${isInv ? `<tr><td style="padding:12px 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${ink3}">
    Invoice ${escapeHtml(inv.number)} · for ${escapeHtml(inv.owner.name)} · due ${fmtDayY(inv.dueISO)}</td></tr>` : ''}

  <tr><td style="padding-top:12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Helvetica,Arial,sans-serif;border-collapse:collapse">
      <tr>${['Date','Dog','Service','Amount'].map((h, i) => `<th align="${i===3?'right':'left'}" style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${ink3};border-bottom:1px solid ${edge};padding:0 8px 6px 0">${h}</th>`).join('')}</tr>
      ${rows}
      <tr><td colspan="3" style="padding:12px 8px 0 0;border-top:2px solid ${edge};font-family:Georgia,serif;font-size:16px;color:${ink}">${isInv ? 'Total due' : 'Nothing to pay'}</td>
          <td style="padding:12px 0 0;border-top:2px solid ${edge};text-align:right;font-family:Georgia,serif;font-size:16px;color:${ink}">${m(inv.total)}</td></tr>
    </table></td></tr>

  ${inv.packNotes.map(p => `<tr><td style="padding-top:14px">
    <div style="background:#eef2e6;border-left:3px solid #6a8f4a;padding:10px 12px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${ink2}">
      <b>${escapeHtml(p.dog)}'s pack</b> — ${p.left} of ${p.size} visit${p.left===1?'':'s'} still to use${p.expires ? `, up to ${fmtDayWk(p.expires)}` : ''}.
    </div></td></tr>`).join('')}

  ${isInv && bank ? `<tr><td style="padding-top:16px">
    <div style="background:${kraft};border-radius:8px;padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${ink2};line-height:1.6">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${ink3};margin-bottom:8px">How to pay · within ${INVOICE_TERMS_DAYS} days</div>
      <b style="color:${ink}">Bank transfer</b> — BSB ${escapeHtml(biz.bsb)} · Account ${escapeHtml(biz.acct)}<br>
      Please use the reference <b style="color:${ink}">${escapeHtml(inv.ref)}</b> so we can match your payment.
      ${biz.stripeLink ? `<br><br><b style="color:${ink}">Card</b> — <a href="${escapeHtml(biz.stripeLink)}" style="color:#6a8f4a">pay online here</a>.` : ''}
    </div></td></tr>` : ''}

  <tr><td style="padding-top:18px;border-top:1px solid ${edge};margin-top:16px;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${ink2};line-height:1.6">
    Thank you — ${escapeHtml(biz.person)} 🐾<br>
    <span style="font-size:11px;color:${ink3}">${escapeHtml(biz.site)} · No GST — not registered.<br>
    Cancellations are free with more than 24 hours' notice, and half the day's rate inside 24 hours.${
      inv.lines.some(l => l.what === 'Late pickup')
        ? ` Pickup after ${friendlyTime(LATE_CUTOFF)} is $${LATE_PER_30} per 30 minutes after a ${LATE_GRACE_MIN} minute grace period, capped at $${LATE_CAP} a day.` : ''}
    </span></td></tr>

</table></td></tr></table></body></html>`;
}

export function invoiceSubject(inv, biz) {
  return inv.nothingDue
    ? `${biz.name} — your visits`
    : `${biz.name} — invoice ${inv.number} · $${inv.total.toFixed(2)}`;
}

/* ---------- deciding what a run should do ---------- */

/* The whole decision, with no IO, so it can be tested and so the panel and the
   Cloud Function agree about what would happen. Returns:
     jobs    invoices to send now
     refused ones a person needs to look at, with the reason
     held    set when the batch is unusually large — send nothing, ask first  */
export function planRun(db, biz, cfg = {}, today) {
  const asAt = today || localISO(new Date());
  const mode = cfg.mode || 'off';
  if (mode === 'off')            return { jobs: [], refused: [], skipped: 'sending is off' };
  if (!biz || !biz.bsb || !biz.acct) return { jobs: [], refused: [], skipped: 'no bank details on file' };

  const jobs = [], refused = [], seen = new Set();

  for (const q of (db.meta?.sendQueue || [])) {
    if (seen.has(q.ownerId)) continue;
    const inv = buildInvoice(db, q.ownerId, { asAt });
    if (!inv) {
      const o = ownerById(db, q.ownerId);
      refused.push({ ownerId: q.ownerId, who: o?.name || q.ownerId, why: 'nothing left to bill — already invoiced?' });
      continue;
    }
    const why = blockers(db, inv, biz, asAt);
    if (why.length) { refused.push({ ownerId: q.ownerId, who: inv.owner.name, why: why.join('; ') }); continue; }
    if (q.total != null && Math.abs(q.total - inv.total) > 0.005) {
      refused.push({ ownerId: q.ownerId, who: inv.owner.name,
        why: `the bookings changed after this was approved — was $${Number(q.total).toFixed(2)}, now $${inv.total.toFixed(2)}. Approve it again.` });
      continue;
    }
    seen.add(q.ownerId); jobs.push(inv);
  }

  if (mode === 'auto') {
    for (const inv of sendableInvoices(db, biz, { asAt })) {
      if (!seen.has(inv.owner.id)) { seen.add(inv.owner.id); jobs.push(inv); }
    }
  }

  const cap = cfg.batchCap == null ? 8 : cfg.batchCap;
  if (jobs.length > cap) return { jobs: [], refused, held: jobs, cap };
  return { jobs, refused };
}
