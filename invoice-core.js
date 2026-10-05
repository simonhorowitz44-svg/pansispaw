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

/* What a client should see an add-on called. Without these the extra is folded
   silently into the day's price and four identical "Full day" lines carry four
   different amounts, which is how an invoice earns a phone call. */
export const ADDON_LABELS = {
  senior: 'Senior care', puppy: 'Puppy care', med: 'Medication',
  diet: 'Special diet', taxi: 'Pickup & drop-off'
};
export const SURCHARGE_LABELS = {
  publicHoliday: 'Public holiday', xmasPeakDay: 'Peak season', xmasPeakNight: 'Peak season'
};

/* What each extra is for, in a sentence. The rate itself is filled in from the
   constants above rather than written out, so a price rise cannot leave the
   explanation describing the old one. Every charged line on an invoice should
   answer "what is this" without anyone having to ask. */
export const ADDON_WHY = {
  senior: 'extra checks and a quieter space, per day',
  puppy:  'closer supervision and more frequent breaks, per day',
  med:    'giving medication, per visit',
  diet:   'preparing their own food, per day',
  taxi:   'collected from home and dropped back, per trip'
};
export const SURCHARGE_WHY = {
  publicHoliday: 'NSW public holiday',
  xmasPeakDay:   'Christmas and summer peak',
  xmasPeakNight: 'Christmas and summer peak'
};
const withRate = (why, amt) => `${why} · $${amt}`;

/* The extras baked into a booking's price, as {what, amt} the invoice can show
   as their own lines. Empty where they don't apply: a custom price is whatever
   Andressa typed, and Scouts is a flat rate with transport already in it. */
export function bookingExtras(b) {
  if (!b || b.cancelled || b.customPrice != null || b.session === 'scouts') return [];
  const out = [];
  for (const k of ['senior', 'puppy', 'med', 'diet', 'taxi'])
    if (b.addOns?.[k] && ADDONS[k])
      out.push({ what: ADDON_LABELS[k], amt: ADDONS[k], note: withRate(ADDON_WHY[k], ADDONS[k]) });
  if (b.surcharges?.publicHoliday && SURCHARGES.publicHoliday)
    out.push({ what: SURCHARGE_LABELS.publicHoliday, amt: SURCHARGES.publicHoliday,
               note: withRate(SURCHARGE_WHY.publicHoliday, SURCHARGES.publicHoliday) });
  if (b.surcharges?.xmasPeak) {
    const night = b.session === 'overnight';
    const amt = night ? SURCHARGES.xmasPeakNight : SURCHARGES.xmasPeakDay;
    if (amt) out.push({ what: SURCHARGE_LABELS.xmasPeakDay, amt,
                        note: withRate(night ? SURCHARGE_WHY.xmasPeakNight : SURCHARGE_WHY.xmasPeakDay, amt) });
  }
  return out;
}

/* Accepts the shape of pricing.json, or plain {prices, addons, surcharges}. */
export function setPricing(p) {
  if (!p) return;
  // Merge per size rather than replacing the table. pricing.json only carries
  // the three daycare sessions, so a wholesale replace left scouts, meet, trial
  // and overnight undefined — and calcTotal's `|| 0` turned undefined into free.
  // No money was lost to this: every Scouts booking on the books carries a
  // customPrice typed in by hand, so calcTotal never priced them. The trap is
  // the first one saved without one — it would be free, and a zero-priced
  // booking produces no invoice line at all, so it reads as a smaller total
  // rather than a missing charge. A price that goes missing must fall back to
  // the built-in one, never to nothing.
  if (p.prices) {
    const merged = {};
    for (const size of new Set([...Object.keys(PRICES), ...Object.keys(p.prices)])) {
      merged[size] = { ...(PRICES[size] || {}), ...(p.prices[size] || {}) };
    }
    PRICES = merged;
  }
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

/* Late pickup. Published on services.html: we close at 5pm, there is half an
   hour of grace, then $10 per 30 minutes capped at $40 a day. Change here and
   on the site together.

   The close moved 5.30pm -> 5pm with the grace 15 -> 30 minutes, which leaves
   the point where money starts changing hands exactly where it was (5.30pm) —
   a 6.30pm collection is $20 before and after. The change is what Andressa
   can say out loud: 5pm is the time she asks for, and a parent stuck in
   traffic has a real buffer rather than a fifteen-minute one. */
export const LATE_CUTOFF    = '17:00';
export const LATE_GRACE_MIN = 30;
export const LATE_PER_30    = 10;
export const LATE_CAP       = 40;

/* Boarding's own window. Never published, so it was carried in Andressa's head
   and priced by memory — which is how one large dog was charged $95, $130 and
   $155 for the same thing inside a fortnight. Same rate and daily cap as
   daycare.

   Grace is its own constant rather than daycare's. Boarding check-in and
   check-out are appointments made with one client, not a school-gate rush, so
   widening daycare's grace to half an hour has no reason to widen this too —
   and quietly doing so would have handed back $10 a stay on every early
   arrival. */
export const BOARD_CHECKIN  = '15:00';
export const BOARD_CHECKOUT = '10:00';
export const BOARD_GRACE_MIN = 15;

const hhmm = x => { const p = String(x || '').split(':'); return (+p[0]) * 60 + (+p[1] || 0); };

/* What a stay owes for arriving before check-in or leaving after check-out.
   Charged per day, not per end: three hours early and ninety minutes late is
   one day's cap, not two. */
export function boardingHoursFee(b) {
  const none = { earlyMin: 0, lateMin: 0, fee: 0, why: '' };
  if (!b || b.session !== 'overnight' || b.cancelled || b.lateFeeWaived) return none;

  const inT  = b.arrivalLogged   || b.arrivalTime;
  const outT = b.departureLogged || b.departureTime;
  let earlyMin = 0, lateMin = 0;
  if (inT  && String(inT).length  >= 4) earlyMin = Math.max(0, hhmm(BOARD_CHECKIN)  - hhmm(inT));
  if (outT && String(outT).length >= 4) lateMin  = Math.max(0, hhmm(outT) - hhmm(BOARD_CHECKOUT));
  if (!earlyMin && !lateMin) return none;

  const over = Math.max(0, earlyMin - BOARD_GRACE_MIN) + Math.max(0, lateMin - BOARD_GRACE_MIN);
  if (!over) return none;
  const uncapped = Math.ceil(over / 30) * LATE_PER_30;
  const fee = Math.min(uncapped, LATE_CAP);

  const bits = [];
  if (earlyMin > BOARD_GRACE_MIN) bits.push(`arrived ${friendlyMins(earlyMin)} before ${friendlyTime(BOARD_CHECKIN)}`);
  if (lateMin  > BOARD_GRACE_MIN) bits.push(`collected ${friendlyMins(lateMin)} after ${friendlyTime(BOARD_CHECKOUT)}`);
  /* Say when the cap bit. The client reads a smaller number than the hours
     imply, and it should be obvious that is the cap doing it rather than
     arithmetic they cannot follow. */
  const why = bits.join(', ') + (uncapped > fee ? ` — capped at $${LATE_CAP}` : '');
  return { earlyMin, lateMin, fee, uncapped, capped: uncapped > fee, why };
}

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
/* 5pm reads better than 17:00 on a document a dog owner reads. */
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
  /* Boarding has its own window — 3pm in, 10am out — and boardingHoursFee
     charges against it. Leaving overnight stays subject to the daycare close
     cutoff as well billed the same lateness twice: a dog collected at 6pm the
     day after cost $10 here and $40 there. */
  if (b.session === 'meet' || b.session === 'trial' || b.session === 'scouts'
      || b.session === 'overnight') return none;
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
  /* Number(), because customPrice is typed by hand and has reached this
     function as a string before. '85' + 10 is '8510' — a $95 day invoiced at
     $8,510, silently, to a real client. The panel parses it today; this is the
     guard for when something else writes it. */
  if (booking.customPrice != null) return Number(booking.customPrice) + late;
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
/* Visits left as at a date — so a reprinted invoice says what it said then.
   A pack past its expiry has nothing left whatever the count says; the days
   were sold with a use-by and the site publishes it. */
export function packLeftAsAt(db, pack, isoDate) {
  if (pack.expiryDate && isoDate > pack.expiryDate) return 0;
  return Math.max(0, pack.size - packRedemptions(db, pack).filter(x => x.date <= isoDate).length);
}

/* Whether a day may be taken off this pack at all. */
export function packCoversDate(pack, isoDate) {
  return !pack.expiryDate || isoDate <= pack.expiryDate;
}

/* ---------- deposits ---------- */

/* A stay is usually held with half the money up front, and the deposit belongs
   to the stay rather than to any one night of it — so it is stored against the
   list of bookings it covers. Paying it does not bill anything: the nights are
   invoiced as normal when the stay finishes, and the deposit comes off the
   bottom as a credit. That way the invoice shows the full price of the stay,
   which is what the client agreed to, and then shows their money coming back
   off it, rather than quietly billing a half they cannot check.

   DEPOSIT_RATE is the default Andressa quotes. The amount is stored on the
   deposit itself, so changing the rate later cannot rewrite what somebody was
   actually asked for. */
export const DEPOSIT_RATE = 0.5;

export function depositFor(db, bookingId) {
  return (db.deposits || []).find(d => (d.bookingIds || []).includes(bookingId)) || null;
}

/* What half of a stay comes to, rounded to whole dollars — nobody asks for
   $162.50 over the phone. */
export function depositDue(bookings, dog, rate = DEPOSIT_RATE) {
  const full = (bookings || []).reduce((t, b) => t + calcTotal(b, dog), 0);
  return Math.round(full * rate);
}

/* A deposit request, shaped exactly like an invoice so it goes through the same
   renderers, the same email and the same bank details. It is not an invoice and
   must never be mistaken for one — it bills none of the nights, stamps nothing
   as billed, and says plainly that the rest follows after the stay. */
export function buildDepositRequest(db, depositId, opts = {}) {
  const dep = (db.deposits || []).find(d => d.id === depositId);
  if (!dep) return null;
  const dog   = (db.dogs || []).find(x => x.id === dep.dogId);
  const owner = dog && (db.owners || []).find(o => o.id === dog.ownerId);
  if (!owner) return null;

  const nights = (db.bookings || []).filter(b => (dep.bookingIds || []).includes(b.id))
                                    .sort((a, b) => a.date.localeCompare(b.date));
  if (!nights.length) return null;
  const asAt  = opts.asAt || dep.requestedAt.slice(0, 10);
  const full  = nights.reduce((t, b) => t + calcTotal(b, dog), 0);
  const from  = nights[0].date, to = nights[nights.length - 1].date;

  /* One line for the stay and one for the deposit. Listing fourteen nights at
     full price on a document asking for half is how a client reads the wrong
     number and pays it. */
  const lines = [
    { date: from, dog: dog.name, what: `${nights.length} night${nights.length === 1 ? '' : 's'}`,
      note: `${fmtDay(from)} to ${fmtDay(to)} · $${full.toFixed(2)} in total`, amt: 0, free: true },
    { date: from, dog: dog.name, what: 'Deposit to hold the stay',
      note: `${Math.round((dep.rate || DEPOSIT_RATE) * 100)}% now, the rest invoiced after they go home`,
      amt: dep.amount }
  ];

  return {
    kind: 'deposit', owner, asAt, lines, bookingIds: [], packNotes: [], warnings: [],
    periodFrom: from, periodTo: to, total: dep.amount, nothingDue: false,
    ref: payRef(db, owner, asAt),
    number: invoiceNumber(owner, asAt, opts.seq || 1).replace(/^PP-/, 'PPD-'),
    dueISO: addDaysISO(asAt, INVOICE_TERMS_DAYS)
  };
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
/* Andressa thinks in dogs, and so do clients — a reference reading ELVIS-0927
   is recognised on a bank statement in a way BURKE-0927 is not. The catch is
   that dog names are not unique: Loki and Simba each belong to three different
   households here. Where a name is shared, the surname goes back in to keep the
   reconciliation able to tell them apart. */
export function dogTag(db, owner) {
  const mine = (db.dogs || []).filter(d => d.ownerId === owner.id);
  if (!mine.length) return ownerTag(db, owner);
  const name = mine.map(d => String(d.name || '').trim()).filter(Boolean).sort()[0] || '';
  const tag = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (!tag) return ownerTag(db, owner);
  const shared = (db.dogs || []).some(d =>
    d.ownerId !== owner.id &&
    String(d.name || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) === tag);
  return shared ? `${tag}-${surnameTag(owner)}` : tag;
}

export function payRef(db, owner, asAtISO) {
  return `${dogTag(db, owner)}-${asAtISO.slice(5,7)}${asAtISO.slice(8,10)}`;
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
  /* Nothing booked this week means nothing is pending, so the run is finished.
     This used to return false, which meant a client who stopped coming could
     never be invoiced again — their last week's visits stayed unbilled forever,
     and the panel said "still has a booking to come this week", which was the
     opposite of true. Whether there is anything to bill is buildInvoice's
     question, not this one. */
  if (!mine.length) return true;
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
  /* The cap is published as "$40 a day", not "$40 a dog". One collection of
     three dogs is one late pickup, so the cap is tallied per date across the
     whole invoice rather than per booking. */
  const lateByDate = {};
  const dates0 = ls => (ls.map(l => l.date).filter(Boolean).sort().pop() || asAt);
  const push = (o, amt, b) => { lines.push({ ...o, amt: amt / 100 }); totalC += amt; if (b && !bookingIds.includes(b.id)) bookingIds.push(b.id); };

  (db.bookings || [])
    /* The go-live date is a blanket floor so the first run cannot bill months
       of history. billAnyway is the deliberate exception: a single old booking
       Andressa knows is unpaid, ticked one at a time. Never a date change —
       moving the floor back would sweep in everyone at once. */
    .filter(b => (b.date >= floor || b.billAnyway) && b.date <= asAt)
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
        const already = lateByDate[b.date] || 0;
        const room    = cents(LATE_CAP) - already;
        if (room <= 0) return;                       // the day is already capped
        const feeC = Math.min(cents(L.fee), room);
        lateByDate[b.date] = already + feeC;
        const capped = feeC < cents(L.fee);
        push({ date:b.date, dog:dogName, what:'Late pickup',
               note:`picked up at ${friendlyTime(b.departureLogged)}, ${friendlyMins(L.minsLate)} after ${friendlyTime(LATE_CUTOFF)}` +
                    (capped ? ` — capped at $${LATE_CAP} for the day` : '') },
             feeC, b);
      };

      if (b.packId) {
        const pk = (db.packs || []).find(p => p.id === b.packId);
        if (!pk) {
          /* The warning said "billed at the normal rate" and that was a lie: a
             redeemed day is stored with total 0, the branch below trusts the
             stored total, and a zero produces no line at all. So the day was
             never charged, never landed in meta.billed, and the warning fired
             again on every future run — which blocks that client's sending
             for good. Price it properly and let it through; the warning still
             puts the invoice in "Needs a look" so nobody pays it blind. */
          warnings.push(`${dogName}'s visit on ${b.date} points at a pack that no longer exists — priced at the normal rate, check it before sending.`);
          b = { ...b, packId: null, total: null, customPrice: b.customPrice === 0 ? null : b.customPrice };
        } else if (!packCoversDate(pk, b.date)) {
          /* Redeemed against a pack that had already expired. The day is not
             free, but it is not something to quietly bill either — she may
             have meant to extend it. */
          warnings.push(`${dogName}'s visit on ${b.date} came off a pack that expired ${pk.expiryDate} — priced at the normal rate, check it before sending.`);
          b = { ...b, packId: null, total: null, customPrice: b.customPrice === 0 ? null : b.customPrice };
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
      /* PRICES[undefined] is undefined and the `|| 0` under it turns that into a
         free day with nothing said. Three dogs on file have no size. */
      let unpriced = false;
      if (dog && !PRICES[dog.size] && b.session !== 'meet' && b.session !== 'trial'
          && b.customPrice == null && b.total == null) {
        warnings.push(`${dogName} has no size on file, so ${b.date} has no rate — it would bill $0.`);
        unpriced = true;
      }
      const priced = calcTotal({ ...b, departureLogged:null }, dog);
      let baseC;
      if (b.total == null)          baseC = cents(priced);
      else if (b.lateFee != null)   baseC = cents(b.total) - cents(b.lateFee);
      else if (cents(b.total) === cents(priced + L.fee)) baseC = cents(b.total) - cents(L.fee);
      else if (L.fee) {
        /* A stored total, a late fee, and no record of whether the fee is
           already inside it. The old guess kept the stored total and then
           addLate() put the fee on again — a double charge whenever the price
           had moved since the row was saved. Price it fresh instead, and say
           so, because billing today's rate for an old day is a decision a
           person should see rather than a silent correction. */
        warnings.push(`${dogName}'s ${b.date} was saved before the late fee was recorded separately, so it has been re-priced at today's rate — check it.`);
        baseC = cents(priced);
      }
      else                          baseC = cents(b.total);
      if (baseC < 0) baseC = 0;

      /* Split the extras back out of the day's price so each one is named.
         They were added by calcTotal, so subtracting them leaves the session
         rate. If that doesn't come out positive the row is odd — show it whole
         rather than invent a breakdown. */
      const extras  = bookingExtras(b);
      const extrasC = extras.reduce((t, x) => t + cents(x.amt), 0);
      const splittable = extras.length && baseC - extrasC > 0;
      const dayC = splittable ? baseC - extrasC : baseC;

      /* A stay says when it started and ended. Without it the client reads a
         night and an extra-hours charge with no way to check either. */
      let stayNote = '';
      if (b.session === 'overnight') {
        const inT  = b.arrivalLogged   || b.arrivalTime;
        const outT = b.departureLogged || b.departureTime;
        if (inT && outT)  stayNote = `dropped ${friendlyTime(inT)}, collected ${friendlyTime(outT)} next day`;
        else if (inT)     stayNote = `dropped ${friendlyTime(inT)}`;
        else if (outT)    stayNote = `collected ${friendlyTime(outT)} next day`;
      }

      /* A zero that is meant to be zero prints "on us". A zero caused by a
         missing rate has to print too, or the line vanishes, the invoice comes
         back empty, buildInvoice returns null, and the warning explaining it
         is thrown away with it — which is how a day could be worth nothing and
         say nothing. */
      /* What the line says for itself.

         A hand-typed price arrives as one bare number with nothing to say why
         it is not the published rate — and sixty-two of the forward bookings
         are hand-typed. That is the line a client queries, and until now the
         only answer lived in Andressa's memory. If she recorded why, say it; if
         she did not, at least say it was agreed rather than calculated.

         The booking's own notes are not published automatically: they are
         working notes and carry things like a dog's upset stomach or a
         difficult handover. They go on the invoice only when she ticks to say
         so, and then they come first, because she wrote them for this. */
      const bits = [];
      if (b.noteOnInvoice && b.notes) bits.push(String(b.notes).trim());
      if (b.customPrice != null && !b.cancelled)
        bits.push(b.customPriceNote ? String(b.customPriceNote).trim() : 'agreed rate');
      if (stayNote) bits.push(stayNote);
      const dayNote = bits.filter(Boolean).join(' · ');

      if (dayC || unpriced || b.session === 'meet' || b.session === 'trial') {
        push({ date:b.date, dog:dogName, what:`${label}${trip}`,
               note: dayC ? dayNote : unpriced ? 'no rate on file — needs a price' : 'on us',
               free: !dayC }, dayC, b);
      }
      if (splittable) extras.forEach(x =>
        push({ date:b.date, dog:dogName, what:x.what, note:x.note || '' }, cents(x.amt), b));

      /* A one-off charge Andressa adds by hand. Its own line rather than folded
         into the price, and below the day it relates to — a charge printed above
         the thing it is charging for reads backwards.

         Where she has not written a reason, work one out rather than printing
         "Additional charge" and nothing else: on a stay the times are already
         recorded, so the invoice can say what they were. That line is the one
         most likely to be queried, so it is the worst one to leave bare. */
      const bh = boardingHoursFee(b);
      if (b.extraCharge) {
        push({ date:b.date, dog:dogName,
               what: b.extraNote || (bh.why ? 'Outside check-in hours' : 'Additional charge'),
               note: bh.why || '' },
             cents(b.extraCharge), b);
      } else if (bh.fee && b.customPrice == null && (() => {
        /* Share the daily cap with late pickups rather than keeping a separate
           one per booking. Two dogs from one household dropped early on the
           same day used to be $40 + $40, against a published cap of $40 a day.
           Same accumulator, same ceiling. */
        const already = lateByDate[b.date] || 0;
        const room    = cents(LATE_CAP) - already;
        if (room <= 0) return false;
        bh.capC = Math.min(cents(bh.fee), room);
        lateByDate[b.date] = already + bh.capC;
        bh.cappedHere = bh.capC < cents(bh.fee);
        return true;
      })()) {
        /* Nobody typed a charge, so bill the stay's own hours. The times are
           already recorded against the booking, the rule is published, and the
           arithmetic is the same every time — there is nothing here for a human
           to decide, and leaving it to one meant it was simply never charged.

           A hand-typed extraCharge still wins. That is the override for the
           stay that was genuinely agreed differently, and it has to beat the
           automatic line rather than add to it.

           A customPrice is left alone for the same reason bookingExtras leaves
           it alone: it is a negotiated all-in number, usually for a long stay,
           and the hours are the thing being negotiated. Charging them on top
           would re-bill a deal that was already struck. Andressa can still add
           an extraCharge by hand if a custom stay genuinely ran over. */
        push({ date:b.date, dog:dogName, what:'Outside check-in hours',
               note: bh.why + (bh.cappedHere ? ` — capped at $${LATE_CAP} for the day` : '') },
             bh.capC, b);
      }
      addLate();
    });

  /* Deposits already paid come off the bottom, once each, after everything has
     been charged. Capped at what the invoice actually comes to: a credit bigger
     than the bill would hand back money on a document that cannot explain it,
     so the remainder is said in words and settled by a human. */
  const creditedDeposits = new Set();
  for (const id of [...bookingIds]) {
    const dep = depositFor(db, id);
    if (!dep || !dep.paidAt || creditedDeposits.has(dep.id)) continue;
    creditedDeposits.add(dep.id);
    const paidC = cents(dep.paidAmount != null ? dep.paidAmount : dep.amount);
    if (paidC <= 0) continue;
    const useC = Math.min(paidC, Math.max(0, totalC));
    push({ date: dates0(lines), dog: '', what: 'Deposit already paid',
           note: `received ${fmtDay(dep.paidAt.slice(0,10))}`, credit: true }, -useC, null);
    if (paidC > useC) {
      warnings.push(`${owner.name}'s deposit was $${(paidC/100).toFixed(2)} but this invoice only came to $${(useC/100).toFixed(2)} — $${((paidC-useC)/100).toFixed(2)} is still theirs.`);
    }
  }

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
  /* A credit reads as −$115.00, not $-115.00 — the minus belongs to the money,
     not to the dollar sign. */
  const m = n => (Number(n) < 0 ? '\u2212$' + Math.abs(Number(n)).toFixed(2) : '$' + Number(n).toFixed(2));
  const bank = biz.bsb && biz.acct;
  const bankOff = bank && biz.bankDiscount > 0 ? biz.bankDiscount : 0;
  const isInv = !inv.nothingDue;
  const isDep = inv.kind === 'deposit';
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
        <div>${escapeHtml(biz.phone)}${biz.email ? ' · ' + escapeHtml(biz.email) : ''}</div>
        ${biz.abn ? `<div>ABN ${escapeHtml(biz.abn)}</div>` : ''}
      </div>
      <div class="inv-kind">${isDep ? 'Deposit' : isInv ? 'Invoice' : 'Summary'}</div>
    </div>

    <div class="inv-meta">
      <div><span>${isDep ? 'Deposit for' : isInv ? 'Invoice for' : 'Summary for'}</span><b>${escapeHtml(inv.owner.name)}</b></div>
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
      <tfoot><tr><td colspan="3">${isDep ? 'Deposit due' : isInv ? 'Total due' : 'Nothing to pay'}</td>
        <td class="r">${m(inv.total)}</td></tr></tfoot>
    </table>

    ${inv.packNotes.map(p => `<div class="inv-pack">
      <b>${escapeHtml(p.dog)}'s pack</b> — ${p.left} of ${p.size} visit${p.left===1?'':'s'} still to use${p.expires ? `, up to ${fmtDayWk(p.expires)}` : ''}.
    </div>`).join('')}

    ${isInv && bank ? `<div class="inv-pay">
      <div class="inv-pay-title">How to pay · ${isDep ? 'to hold the dates' : `within ${INVOICE_TERMS_DAYS} days`}</div>
      <div class="inv-pay-row"><b>Bank transfer</b>${biz.acctName ? ` — ${escapeHtml(biz.acctName)}` : ''}<br>
        BSB ${escapeHtml(biz.bsb)} · Account ${escapeHtml(biz.acct)}<br>
        Please use the reference <b>${escapeHtml(inv.ref)}</b> so we can match your payment.${
        bankOff ? `<br>Pay this way and it's <b>${m(inv.total - bankOff)}</b> — $${bankOff} off.` : ''}</div>
      ${biz.stripeLink ? `<div class="inv-pay-row"><b>Card</b> — <a href="${escapeHtml(biz.stripeLink)}">pay online here</a>.</div>` : ''}
    </div>` : ''}

    <div class="inv-foot">
      Thank you — ${escapeHtml(biz.person)} 🐾 · ${escapeHtml(biz.site)}<br>
      <span>${isInv ? `Payment within ${INVOICE_TERMS_DAYS} days. ` : ''}
      Cancellations are free with more than 24 hours' notice, and half the day's rate inside 24 hours.${
        inv.lines.some(l => l.what === 'Late pickup')
          ? ` Pickup after ${friendlyTime(LATE_CUTOFF)} is $${LATE_PER_30} per 30 minutes once a ${LATE_GRACE_MIN} minute grace period has passed, capped at $${LATE_CAP} a day.` : ''}${
        /* The check-in line used to arrive with no rate, no grace and no cap
           stated anywhere — the one charge most likely to be queried was the
           only one that explained nothing. Worded as hours rather than
           boarding, to match how the session itself is labelled. */
        inv.lines.some(l => l.what === 'Outside check-in hours')
          ? ` Arrival before ${friendlyTime(BOARD_CHECKIN)} or collection after ${friendlyTime(BOARD_CHECKOUT)} is $${LATE_PER_30} per 30 minutes once a ${BOARD_GRACE_MIN} minute grace period has passed, capped at $${LATE_CAP} a day.` : ''}</span>
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
    : inv.kind === 'deposit' ? `Here's the deposit to hold ${inv.lines[0].dog}'s stay, ${period}.`
    : `Here's your invoice for ${period}.`);
  L.push('');
  inv.lines.forEach(l => L.push(
    `${fmtDay(l.date)}  ${l.dog ? l.dog + ' · ' : ''}${l.what}${l.note ? ' (' + l.note + ')' : ''}  ${
       l.amt ? (l.amt < 0 ? '-$' + Math.abs(l.amt).toFixed(2) : '$' + l.amt.toFixed(2)) : '—'}`));
  L.push('');
  L.push(inv.nothingDue ? 'Nothing to pay.'
    : inv.kind === 'deposit' ? `Deposit due: $${inv.total.toFixed(2)} to hold the dates`
    : `Total due: $${inv.total.toFixed(2)} by ${fmtDayY(inv.dueISO)}`);
  inv.packNotes.forEach(p => L.push(`${p.dog}'s pack — ${p.left} of ${p.size} still to use${p.expires ? ', up to ' + fmtDayWk(p.expires) : ''}.`));
  if (!inv.nothingDue && biz.bsb && biz.acct) {
    L.push('', 'How to pay', 'Bank transfer');
    if (biz.acctName) L.push(`Account name: ${biz.acctName}`);
    L.push(`BSB ${biz.bsb}, Account ${biz.acct}`, `Reference: ${inv.ref}`);
    if (biz.stripeLink) L.push(`Or by card: ${biz.stripeLink}`);
  }
  /* The plain-text invoice carried no terms at all — not the cancellation
     rule, not the late fee, nothing. Some clients only ever read this version,
     and a charge they cannot find an explanation for is the one they query. */
  L.push('', "Cancellations are free with more than 24 hours' notice, and half the day's rate inside 24 hours.");
  if (inv.lines.some(l => l.what === 'Late pickup'))
    L.push(`Pickup after ${friendlyTime(LATE_CUTOFF)} is $${LATE_PER_30} per 30 minutes once a ${LATE_GRACE_MIN} minute grace period has passed, capped at $${LATE_CAP} a day.`);
  if (inv.lines.some(l => l.what === 'Outside check-in hours'))
    L.push(`Arrival before ${friendlyTime(BOARD_CHECKIN)} or collection after ${friendlyTime(BOARD_CHECKOUT)} is $${LATE_PER_30} per 30 minutes once a ${BOARD_GRACE_MIN} minute grace period has passed, capped at $${LATE_CAP} a day.`);

  L.push('', `Thank you — ${biz.person} 🐾`, biz.name + (biz.abn ? ` · ABN ${biz.abn}` : ''));
  return L.join('\n');
}

/* ---------- email ---------- */

/* Email clients don't do custom properties, half of them strip <style>, and a
   few still want tables. So the email is built with inline styles and literal
   colours rather than reusing the panel's stylesheet. The numbers come from the
   same buildInvoice, which is the part that must not diverge. */
export function renderInvoiceEmail(inv, biz, o = {}) {
  /* A credit reads as −$115.00, not $-115.00 — the minus belongs to the money,
     not to the dollar sign. */
  const m = n => (Number(n) < 0 ? '\u2212$' + Math.abs(Number(n)).toFixed(2) : '$' + Number(n).toFixed(2));
  const ink = '#3f2814', ink2 = '#6b5641', ink3 = '#93826d';
  const edge = '#e6dcc8', kraft = '#f6efdd', paper = '#faf6ed';
  const bank = biz.bsb && biz.acct;
  const isInv = !inv.nothingDue;
  const isDep = inv.kind === 'deposit';
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
        ${escapeHtml(biz.phone)}${biz.email ? ' · ' + escapeHtml(biz.email) : ''}${biz.abn ? `<br>ABN ${escapeHtml(biz.abn)}` : ''}</div></td>
      <td align="right" style="vertical-align:top;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${ink3}">${isDep ? 'Deposit' : isInv ? 'Invoice' : 'Summary'}</td>
    </tr></table></td></tr>

  <tr><td style="padding:18px 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:${ink2};line-height:1.6">
    Hi ${escapeHtml(first)},<br>
    ${isDep ? `Here's the deposit to hold ${escapeHtml(inv.lines[0].dog)}'s stay, ${period}.` : isInv ? `Here's your invoice for ${period}.` : `Here's a summary of your time with us, ${period}.`}
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
      <b style="color:${ink}">Bank transfer</b>${biz.acctName ? ` — ${escapeHtml(biz.acctName)}` : ''}<br>
      BSB ${escapeHtml(biz.bsb)} · Account ${escapeHtml(biz.acct)}<br>
      Please use the reference <b style="color:${ink}">${escapeHtml(inv.ref)}</b> so we can match your payment.
      ${biz.stripeLink ? `<br><br><b style="color:${ink}">Card</b> — <a href="${escapeHtml(biz.stripeLink)}" style="color:#6a8f4a">pay online here</a>.` : ''}
    </div></td></tr>` : ''}

  <tr><td style="padding-top:18px;border-top:1px solid ${edge};margin-top:16px;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${ink2};line-height:1.6">
    Thank you — ${escapeHtml(biz.person)} 🐾<br>
    <span style="font-family:Georgia,'Times New Roman',serif;font-size:14px;color:${ink}">${escapeHtml(biz.name)}</span><br>
    <span style="font-size:12px;color:${ink2}">${escapeHtml(biz.suburb || '')}${biz.suburb && biz.phone ? ' · ' : ''}${escapeHtml(biz.phone || '')}</span><br>
    <span style="font-size:11px;color:${ink3}">${escapeHtml(biz.site)}<br>
    Cancellations are free with more than 24 hours' notice, and half the day's rate inside 24 hours.${
      inv.lines.some(l => l.what === 'Late pickup')
        ? ` Pickup after ${friendlyTime(LATE_CUTOFF)} is $${LATE_PER_30} per 30 minutes after a ${LATE_GRACE_MIN} minute grace period, capped at $${LATE_CAP} a day.` : ''}${
      inv.lines.some(l => l.what === 'Outside check-in hours')
        ? ` Arrival before ${friendlyTime(BOARD_CHECKIN)} or collection after ${friendlyTime(BOARD_CHECKOUT)} is $${LATE_PER_30} per 30 minutes after a ${BOARD_GRACE_MIN} minute grace period, capped at $${LATE_CAP} a day.` : ''}
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
  /* A blank go-live means "bill everything ever", which on the first automatic
     run is years of history in one email. The batch cap counts invoices, not
     visits, so a single client with 34 old bookings sails straight through it.
     Refuse rather than guess a date. */
  if (!cfg.goLive)               return { jobs: [], refused: [], skipped: 'no go-live date set' };
  if (!biz || !biz.bsb || !biz.acct) return { jobs: [], refused: [], skipped: 'no bank details on file' };

  const jobs = [], refused = [], seen = new Set();
  // The caller's config wins over whatever is on the db — otherwise a run can
  // be told one go-live date and quietly bill from another.
  const opts = { asAt, from: cfg.goLive || undefined };

  for (const q of (db.meta?.sendQueue || [])) {
    if (seen.has(q.ownerId)) continue;
    const inv = buildInvoice(db, q.ownerId, opts);
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
    for (const inv of sendableInvoices(db, biz, opts)) {
      if (!seen.has(inv.owner.id)) { seen.add(inv.owner.id); jobs.push(inv); }
    }
  }

  const cap = cfg.batchCap == null ? 8 : cfg.batchCap;
  if (jobs.length > cap) return { jobs: [], refused, held: jobs, cap };
  return { jobs, refused };
}
