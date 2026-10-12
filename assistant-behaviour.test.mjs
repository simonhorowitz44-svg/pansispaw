/* Runs the real askRunTool against a fixture, with the panel's DOM and
   Firebase dependencies stubbed. Proves behaviour, not just wiring. */
import { readFileSync } from 'node:fs';
import * as C from './invoice-core.js';
import { tierOf } from './assistant-tools.js';

const panel = readFileSync('./admin-v2.html','utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
/* Start just after ASK_FN, which needs httpsCallable, and take everything
   up to the send handlers. */
const src = panel.slice(panel.indexOf('const ASK_KEEP'), panel.indexOf('/* ---- the tap ----'));

let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log('  ok   '+n);} else {fail++;console.log('  FAIL '+n);} };
const eq=(n,a,b)=>ok(n+(a===b?'':`  (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`), a===b);

const BIZ={name:"Pansi's Paws Home Daycare",person:'Andressa Ubida Fernandes',suburb:'Annandale, Sydney',
           phone:'0410 151 509',site:'pansispaws.com.au',bsb:'062-000',acct:'12345678'};

function freshDB(){
  const d=(dd)=>`2026-10-${String(dd).padStart(2,'0')}`;
  return {
    owners:[{id:'o1',name:'Ada Finch',email:'kate@x.com'},
            {id:'o2',name:'Bruno Sala',email:'dan@x.com'},
            {id:'o3',name:'Nina Kovac',email:''}],
    dogs:[{id:'d1',ownerId:'o1',name:'Luna',size:'medium',breed:'cavoodle'},
          {id:'d2',ownerId:'o2',name:'Luna',size:'large',breed:'kelpie'},
          {id:'d3',ownerId:'o3',name:'Luna',size:'small',breed:'lab'},
          {id:'d4',ownerId:'o1',name:'Marlow',size:'medium',breed:'groodle'},
          {id:'d5',ownerId:'o2',name:'Biscuit',size:'medium',breed:'beagle'}],
    bookings:[
      {id:'b1',dogId:'d4',date:d(15),session:'scouts',scoutsTrip:'am',cancelled:false},
      {id:'b2',dogId:'d1',date:d(15),session:'scouts',scoutsTrip:'am',cancelled:false},
      {id:'b3',dogId:'d2',date:d(15),session:'scouts',scoutsTrip:'am',cancelled:false},
      {id:'b4',dogId:'d3',date:d(15),session:'scouts',scoutsTrip:'am',cancelled:false},
      {id:'b5',dogId:'d4',date:d(5),session:'full',cancelled:false},
      /* o3 has no email and a booking already behind her, so her invoice
         builds and is then blocked on the email — which is the case worth
         testing. A client with only future bookings has nothing to block. */
      {id:'b6',dogId:'d3',date:d(6),session:'full',cancelled:false}
    ],
    packs:[],payments:[],deposits:[],
    meta:{billed:{},invoicesSent:[],sendQueue:[],invoicing:{goLive:'2026-09-01'},biz:BIZ}
  };
}

/* One DB object for the life of the run, reset by mutating in place. The
   injected code captures the reference once, so reassigning the variable
   would silently leave it writing to a discarded copy. */
const DB=freshDB();
const reset=()=>{ for (const k of Object.keys(DB)) delete DB[k]; Object.assign(DB, freshDB()); saves=0; toasts=[]; };
let saves=0, renders=0, toasts=[];
const deps={
  DB,
  save: async db=>{saves++;}, render:()=>{renders++;}, toast:(m,k)=>toasts.push([m,k]),
  dogById:id=>DB.dogs.find(x=>x.id===id), ownerById:id=>DB.owners.find(x=>x.id===id),
  uid:(n=>()=>'x'+(++n))(0), todayISO:()=>'2026-10-12',
  fmtDateShort:iso=>new Date(iso+'T00:00:00').toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'}),
  BIZ, tierOf,
  cancelQuote:bk=>{ const hrs=(new Date(bk.date+'T09:00:00')-new Date('2026-10-12T09:00:00'))/36e5;
                    const would=C.calcTotal(bk,DB.dogs.find(d=>d.id===bk.dogId));
                    return {hours:hrs,late:hrs<24,wouldHaveBeen:would,charge:hrs<24?Math.round(would*C.CANCEL_CHARGE_RATE):0}; },
  openBookingSheet:()=>{}, openClientMoney:()=>{}, openOneInvoice:()=>{}, closeAsk:()=>{},
  /* The panel rehydrates BIZ from the document before every tool; mirror that
     here, so a fixture whose bank details live in meta.biz behaves as the real
     thing does. */
  nowTime:()=>'08:00',
  calcPackPrice:(size,n)=>Math.round((C.PRICES[size]?.full||90)*n*(n===10?0.9:n===5?0.95:1)),
  addDaysISO:C.addDaysISO,
  invBuckets:()=>{ const all=C.invoicesDue(DB,{asAt:'2026-10-12'});
    const out={ready:[],waiting:[],blocked:[],sending:[],receipts:[]};
    all.forEach(inv=>{ const why=C.blockers(DB,inv,BIZ,'2026-10-12');
      if(!why.length) out.ready.push(inv);
      else if(why.length===1&&why[0].startsWith('Still has')) out.waiting.push(inv);
      else out.blocked.push({inv,why}); });
    return out; },
  renderInvoices:()=>{}, openInvoicesSheet:()=>{}, openDogEditSheet:()=>{},
  hydrateBiz:()=>{ const b=(DB.meta&&DB.meta.biz)||{}; BIZ.bsb=b.bsb||''; BIZ.acct=b.acct||''; BIZ.acctName=b.acctName||''; BIZ.abn=b.abn||''; },
  drainPendingRemote:()=>{}, document:{getElementById:()=>null}, window:{matchMedia:()=>({matches:false})},
  console
};
const names=['escapeHtml','SESSION_LABELS','calcTotal','buildInvoice','blockers','invoicesDue','depositDue',
             'cancelBands','MIN_DEPOSIT_NIGHTS','DEPOSIT_RATE','PRICES','LATE_CUTOFF','friendlyTime','invoicesDue','buildDepositRequest','latePickupFee','invoiceSubject',
             'CANCEL_NOTICE_HOURS','CANCEL_CHARGE_RATE'];
names.forEach(n=>deps[n]=C[n]);
const keys=Object.keys(deps);
const make=new Function(...keys, src + '\n; return { askRunTool, ASK, askTrim, ASK_KEEP };');
const { askRunTool, ASK, askTrim, ASK_KEEP } = make(...keys.map(k=>deps[k]));
const run=(n,a)=>askRunTool(n,a);
const dogOwner=id=>(DB.dogs.find(d=>d.id===id)||{}).ownerId;

console.log('\n--- find_dogs must not pick one ---');
{
  const r=await run('find_dogs',{query:'luna'});
  ok('three Lunas come back', (r.say.match(/dogId/g)||[]).length===3);
  ok('it tells the model not to choose', /do not pick one/i.test(r.say));
  ok('and shows Andressa the choice', /Which one\?/.test(r.card));
  ok('each option names the owner', /Ada Finch/.test(r.card)&&/Bruno Sala/.test(r.card));
  ok('nothing was saved', saves===0);
  const one=await run('find_dogs',{query:'enzo'});
  ok('a single match shows no card', one.card==='');
  ok('a missing email is flagged to the model', /NO EMAIL/.test((await run('find_dogs',{query:'nina'})).say));
}

console.log('\n--- the four-dog Scouts cap ---');
{
  reset();
  const r=await run('book',{dogId:'d4',dates:['2026-10-15'],session:'scouts',scoutsTrip:'am'});
  ok('a fifth dog is refused', /Nothing booked/.test(r.say));
  eq('nothing was written', DB.bookings.length, 6);
  eq('and nothing was saved', saves, 0);
  /* The same dog on the same day is a duplicate whichever trip it is — which
     matches the booking sheet's own check, and a dog doing six hours of
     adventure in a day is a mis-parse rather than a plan. */
  const sameDogPm=await run('book',{dogId:'d4',dates:['2026-10-15'],session:'scouts',scoutsTrip:'pm'});
  ok('the same dog cannot take both trips in a day', /Nothing booked/.test(sameDogPm.say));
  /* A different dog on the afternoon trip is fine — the cap is per trip. */
  const other=await run('book',{dogId:'d5',dates:['2026-10-15'],session:'scouts',scoutsTrip:'pm'});
  ok('another dog can take the afternoon trip', /Booked/.test(other.say));
  eq('which did write', DB.bookings.length, 7);
  /* And the morning cap still bites for that dog. */
  const capped=await run('book',{dogId:'d5',dates:['2026-10-15'],session:'scouts',scoutsTrip:'am'});
  ok('but not the full morning trip', /Nothing booked/.test(capped.say));
  ok('and the reason given is the cap', /four-dog cap/.test(capped.say));
}

console.log('\n--- duplicates ---');
{
  reset();
  const r=await run('book',{dogId:'d4',dates:['2026-10-05'],session:'full'});
  ok('the same dog, day and session is refused', /Nothing booked/.test(r.say));
  eq('nothing new written', DB.bookings.length, 6);
  const mix=await run('book',{dogId:'d4',dates:['2026-10-05','2026-10-06'],session:'full'});
  ok('a part-duplicate books the rest', /Booked/.test(mix.say));
  ok('and says which it skipped', /Skipped 2026-10-05/.test(mix.say));
  eq('exactly one new booking', DB.bookings.length, 7);
}

console.log('\n--- book writes a correctly priced booking ---');
{
  reset();
  const r=await run('book',{dogId:'d4',dates:['2026-10-20','2026-10-21'],session:'full'});
  const made=DB.bookings.filter(b=>b.date>='2026-10-20');
  eq('two bookings', made.length, 2);
  eq('priced from calcTotal, medium full day', made[0].total, 90);
  eq('saved once, not twice', saves, 1);
  ok('the card offers an undo', /askUndo/.test(r.card));
  ok('the model is given the booking ids', /bookingIds/.test(r.say));
}

console.log('\n--- undo actually reverses ---');
{
  reset();
  await run('book',{dogId:'d4',dates:['2026-10-20'],session:'full'});
  eq('booked', DB.bookings.length, 7);
  const id=[...ASK.undo.keys()].pop();
  await ASK.undo.get(id)();
  eq('undone', DB.bookings.length, 6);
  ok('the undo saved too', saves===2);
}

console.log('\n--- cancellation charges ---');
{
  reset();
  DB.bookings.push({id:'b9',dogId:'d4',date:'2026-10-12',session:'full',cancelled:false});
  const r=await run('cancel',{bookingId:'b9'});
  const bk=DB.bookings.find(b=>b.id==='b9');
  ok('cancelled', bk.cancelled===true);
  eq('charged half of $90 inside 24 hours', bk.cancelCharge, 45);
  ok('the model is told to flag it', /often means to waive it/.test(r.say));
  ok('Andressa sees the charge', /45/.test(r.card));
  ok('and is offered a waive', /Waive the charge/.test(r.card));

  reset();
  const far=await run('cancel',{bookingId:'b1'});
  eq('a booking days out is free', DB.bookings.find(b=>b.id==='b1').cancelCharge, 0);
  ok('and says so', /free/.test(far.say));

  reset();
  DB.bookings.push({id:'b8',dogId:'d4',date:'2026-10-12',session:'full',cancelled:false});
  await run('cancel',{bookingId:'b8',waive:true});
  eq('waive overrides the charge', DB.bookings.find(b=>b.id==='b8').cancelCharge, 0);
}

console.log('\n--- a cancelled pack day goes back ---');
{
  reset();
  DB.packs.push({id:'p1',dogId:'d4',size:10,daysUsed:3,paidAmount:665});
  DB.bookings.push({id:'b7',dogId:'d4',date:'2026-10-20',session:'full',cancelled:false,packId:'p1',customPrice:0});
  await run('cancel',{bookingId:'b7'});
  eq('the pack day is returned', DB.packs[0].daysUsed, 2);
  eq('and the free price goes with it', DB.bookings.find(b=>b.id==='b7').customPrice, null);
  const id=[...ASK.undo.keys()].pop();
  await ASK.undo.get(id)();
  eq('undo puts the pack day back', DB.packs[0].daysUsed, 3);
  eq('and restores the pack link', DB.bookings.find(b=>b.id==='b7').packId, 'p1');
}

console.log('\n--- payments ---');
{
  reset();
  const r=await run('record_payment',{ownerId:'o1',amount:90,date:'2026-10-02'});
  eq('recorded', DB.payments.length, 1);
  eq('the amount', DB.payments[0].amount, 90);
  eq('the date she gave, not today', DB.payments[0].date, '2026-10-02');
  ok('the balance comes from buildInvoice', /still owe|clears them/.test(r.say));
  const bad=await run('record_payment',{ownerId:'o1',amount:-5});
  ok('a negative is refused', /positive/.test(bad.say));
  eq('and nothing extra written', DB.payments.length, 1);
}

console.log('\n--- send tools propose and stop ---');
{
  reset();
  DB.meta.biz=BIZ;
  const r=await run('send_invoice',{ownerId:'o1',now:true});
  ok('it halts the loop', r.halt===true);
  eq('nothing queued', DB.meta.sendQueue.length, 0);
  ok('the model is told it cannot send', /NOT been sent|cannot send it/i.test(r.say));
  ok('a Send button is offered', /askConfirmSend/.test(r.card));

  const noEmail=await run('send_invoice',{ownerId:'o3',now:true});
  ok('a client with no email is blocked', /Cannot send/i.test(noEmail.say));
  ok('and the reason is the real blockers string', /No email address for this client/.test(noEmail.say));
  ok('it halts rather than hunting for a way round', noEmail.halt===true);
  eq('still nothing queued', DB.meta.sendQueue.length, 0);
}

console.log('\n--- a receipt is only a receipt once the money is in ---');
{
  /* Asking for a receipt used to only waive the "nothing to pay" blocker. The
     document was still an unpaid invoice, the card labelled it "Receipt"
     because that is what was asked for, and a client who had already paid got
     a bill for $90 with bank details on it. */
  reset();
  const unpaid = await run('send_receipt',{ownerId:'o1'});
  ok('a receipt on an unpaid week is refused', /Cannot send .* a receipt/.test(unpaid.say));
  ok('the reason given is the missing payment', /no payment has been recorded/.test(unpaid.say));
  ok('the model is told not to send a bill instead', /already paid/.test(unpaid.say));
  ok('Andressa is shown what is outstanding', /Not a receipt yet/.test(unpaid.card));
  ok('and offered the fix', /Record the payment/.test(unpaid.card));
  ok('it halts', unpaid.halt===true);
  eq('nothing queued', DB.meta.sendQueue.length, 0);

  /* Record the payment and the same request now works. Drop the owner's
     later booking first, or the week-not-finished rule blocks it for an
     unrelated and entirely correct reason. */
  DB.bookings = DB.bookings.filter(b => b.date <= '2026-10-12' || dogOwner(b.dogId) !== 'o1');
  const inv = C.buildInvoice(DB,'o1',{asAt:'2026-10-12'});
  await run('record_payment',{ownerId:'o1',amount:inv.total});
  const paid = await run('send_receipt',{ownerId:'o1'});
  ok('once paid it is proposed', /Prepared/.test(paid.say));
  ok('and the document knows it is a receipt', /is a receipt/.test(paid.say));
  ok('the card says receipt', /Receipt/.test(paid.card));
  ok('and shows paid in full rather than an amount due', /paid in full/.test(paid.card));
  ok('it never says money is due', !/due<\/b>|<b>\$[0-9]/.test(paid.card.replace(/paid in full/,'')));
}

console.log('\n--- an invoice never calls itself a receipt ---');
{
  reset();
  const inv = await run('send_invoice',{ownerId:'o1',now:true});
  ok('an unpaid week is labelled an invoice', /Invoice/.test(inv.card));
  ok('and warns it asks for money', /asks for money/.test(inv.card));
  ok('the model is told what it is', /an invoice asking for/.test(inv.say));
  ok('the card never says receipt', !/Receipt/.test(inv.card));
}

console.log('\n--- invoice_state explains rather than fails ---');
{
  reset();
  const r=await run('invoice_state',{ownerId:'o1'});
  ok('it returns one of the three states', /READY|WAITING|BLOCKED/.test(r.say));
  ok('waiting is described as not a fault', !/WAITING/.test(r.say) || /not broken/.test(r.say));
}

console.log('\n--- every card escapes what it prints ---');
{
  reset();
  /* Two matches, so the disambiguation card actually renders. A dog name is
     typed by a human into a form and ends up inside innerHTML. */
  DB.dogs.push({id:'d9',ownerId:'o1',name:'<img src=x onerror=alert(1)>Luna',size:'small'});
  const r=await run('find_dogs',{query:'luna'});
  ok('the card did render', /Which one\?/.test(r.card));
  ok('a hostile dog name cannot inject markup', !/<img src=x/.test(r.card));
  ok('it is escaped, not stripped', /&lt;img/.test(r.card));
}

console.log('\n--- the day carries money ---');
{
  /* "What's on tomorrow" is usually "how much are we taking tomorrow". It
     returned session names and no figures, and the model correctly said it
     could not answer — so it could not answer the question actually being
     asked. */
  reset();
  const r=await run('day',{from:'2026-10-15'});
  ok('each dog carries a price', /\$75/.test(r.card));
  ok('the day has a total', /Total/.test(r.card));
  ok('the model is given the total', /Total for the period/.test(r.say));
  ok('and told not to add it up again', /use it as given/.test(r.say));
  /* Four medium Scouts dogs at $75 */
  ok('the total is right', /\$300/.test(r.card));
  ok('the cap is still reported', /4 of 4|full/.test(r.say));
}

console.log('\n--- quoting without booking ---');
{
  reset();
  const before=DB.bookings.length;
  const q=await run('quote',{dogId:'d4',session:'full'});
  ok('a medium full day quotes at $90', /\$90/.test(q.card));
  ok('it says which dog it is for', /Marlow/.test(q.say));
  ok('and that size is why', /size/i.test(q.say));
  eq('nothing was booked', DB.bookings.length, before);
  eq('and nothing saved', saves, 0);

  const many=await run('quote',{dogId:'d4',session:'overnight',count:5});
  ok('five nights at $115 is $575', /\$575/.test(many.card));
  ok('and it quotes the deposit', /\$288|Deposit/.test(many.card));
  const few=await run('quote',{dogId:'d4',session:'overnight',count:2});
  ok('under three nights takes no deposit', /no deposit/i.test(few.say));
  const free=await run('quote',{dogId:'d4',session:'meet'});
  ok('a meet is free', /\$0/.test(free.card));
}

console.log('\n--- the conversation trims instead of dying ---');
{
  /* This started as a hard refusal at 40 messages, which a real session hit
     after about ten questions and then stopped working entirely. The cut has
     to land on a real user turn: a tool_result whose tool_use has been
     trimmed away is rejected by the API, so a careless trim breaks the
     conversation rather than shortening it. */
  const exchange = (n) => ([
    { role:'user', content:'question ' + n },
    { role:'assistant', content:[{type:'text',text:'ok'},{type:'tool_use',id:'t'+n,name:'day',input:{}}] },
    { role:'user', content:[{type:'tool_result',tool_use_id:'t'+n,content:'result'}] },
    { role:'assistant', content:[{type:'text',text:'answer '+n}] }
  ]);
  const build = n => Array.from({length:n},(_,i)=>exchange(i)).flat();

  const short = build(3);                       // 12 messages
  eq('a short conversation is untouched', askTrim(short).length, short.length);

  const long = build(30);                       // 120 messages
  const cut = askTrim(long);
  ok('a long one is trimmed', cut.length < long.length);
  ok('and is within the window', cut.length <= ASK_KEEP);
  ok('it starts on a real user turn',
     cut[0].role === 'user' && typeof cut[0].content === 'string');

  /* The invariant that actually matters. */
  const ids = new Set();
  for (const m of cut)
    if (Array.isArray(m.content))
      for (const c of m.content) if (c.type === 'tool_use') ids.add(c.id);
  let orphans = 0;
  for (const m of cut)
    if (Array.isArray(m.content))
      for (const c of m.content)
        if (c.type === 'tool_result' && !ids.has(c.tool_use_id)) orphans++;
  eq('no tool_result is left without its tool_use', orphans, 0);

  /* The most recent exchange must survive, or the answer loses its question. */
  ok('the newest turn is kept', JSON.stringify(cut).includes('question 29'));

  /* One enormous exchange with no clean boundary must not return nothing. */
  const runaway = [{role:'user',content:'go'}].concat(
    Array.from({length:120},(_,i)=>([
      {role:'assistant',content:[{type:'tool_use',id:'r'+i,name:'day',input:{}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'r'+i,content:'x'}]}])).flat());
  const rc = askTrim(runaway);
  ok('a runaway exchange still returns something valid',
     rc.length > 0 && rc[0].role === 'user' && typeof rc[0].content === 'string');
}

console.log('\n--- checking dogs in and out ---');
{
  reset();
  const r=await run('check_in',{all:true,date:'2026-10-15',time:'08:00'});
  ok('everyone booked that day is marked in', /Marked in 4/.test(r.say));
  eq('and stamped', DB.bookings.filter(b=>b.date==='2026-10-15'&&b.arrivalLogged==='08:00').length, 4);
  ok('the card shows the time', /arrived 08:00/.test(r.card));

  /* A second arrival time would overwrite the real one, and the late fee is
     worked out from these stamps. */
  const again=await run('check_in',{all:true,date:'2026-10-15'});
  ok('a second check-in changes nothing', /Nothing to do/.test(again.say));
  eq('times are untouched', DB.bookings.filter(b=>b.arrivalLogged==='08:00').length, 4);

  const out=await run('check_out',{all:true,date:'2026-10-15',time:'16:00'});
  ok('they can be collected', /Collected 4/.test(out.say));
  eq('and stamped out', DB.bookings.filter(b=>b.departureLogged==='16:00').length, 4);

  reset();
  const never=await run('check_out',{all:true,date:'2026-10-15'});
  ok('dogs never marked in are not collected', /none of them are here/.test(never.say));
  eq('nothing stamped', DB.bookings.filter(b=>b.departureLogged).length, 0);

  reset();
  await run('check_in',{all:true,date:'2026-10-15',time:'08:00'});
  const undoId=[...ASK.undo.keys()].pop();
  await ASK.undo.get(undoId)();
  eq('undo clears the stamps', DB.bookings.filter(b=>b.arrivalLogged).length, 0);
}

console.log('\n--- adding a dog ---');
{
  reset();
  const r=await run('add_dog',{name:'Rufus',size:'large',breed:'ridgeback',ownerName:'Tom Vale'});
  eq('the dog exists', DB.dogs.filter(d=>d.name==='Rufus').length, 1);
  eq('and so does the new client', DB.owners.filter(o=>o.name==='Tom Vale').length, 1);
  ok('a missing email is flagged hard', /NO EMAIL/.test(r.say));
  ok('and explained on the card', /cannot be invoiced/.test(r.card));
  const id=[...ASK.undo.keys()].pop();
  await ASK.undo.get(id)();
  eq('undo removes the dog', DB.dogs.filter(d=>d.name==='Rufus').length, 0);
  eq('and the client it created', DB.owners.filter(o=>o.name==='Tom Vale').length, 0);

  const onExisting=await run('add_dog',{name:'Pip',size:'small',ownerId:'o1'});
  ok('an existing client is reused', !/client is new/.test(onExisting.say));
  eq('no duplicate owner', DB.owners.filter(o=>o.id==='o1').length, 1);
}

console.log('\n--- packs, deposits, prices ---');
{
  reset();
  const pk=await run('sell_pack',{dogId:'d4',size:10});
  eq('a pack is recorded', DB.packs.length, 1);
  eq('priced from calcPackPrice — 10 medium days less 10%', DB.packs[0].paidAmount, 810);
  ok('the per-day figure is shown', /Per day/.test(pk.card));
  const deal=await run('sell_pack',{dogId:'d4',size:10,paidAmount:665});
  ok('a deal is flagged against the standard', /Standard price/.test(deal.card));

  reset();
  const noNights=await run('record_deposit',{dogId:'d4'});
  ok('no boarding means no deposit', /no boarding nights/.test(noNights.say));
  for (let i=0;i<5;i++) DB.bookings.push({id:'n'+i,dogId:'d4',date:'2026-12-'+(20+i),session:'overnight',cancelled:false});
  const dep=await run('record_deposit',{dogId:'d4'});
  eq('a deposit is created', DB.deposits.length, 1);
  eq('at half of five nights at $115', DB.deposits[0].amount, 288);
  ok('it says nothing has been sent', /Nothing has been sent/.test(dep.say));
  ok('and carries the cancellation dates', /Full refund before/.test(dep.card));
  const twice=await run('record_deposit',{dogId:'d4'});
  ok('a second deposit on the same stay is refused', /already has a deposit/.test(twice.say));

  reset();
  const sp=await run('set_price',{bookingId:'b5',price:55});
  eq('the price changes', DB.bookings.find(b=>b.id==='b5').total, 55);
  ok('the old figure is shown too', /90/.test(sp.card));
  await run('set_price',{bookingId:'b5',price:null});
  eq('null resets to standard', DB.bookings.find(b=>b.id==='b5').total, 90);
}

console.log('\n--- vaccinations ---');
{
  reset();
  DB.dogs[0].vaccDate='2025-01-01';
  DB.dogs[1].vaccDate='2027-06-01';
  const v=await run('vaccinations_due',{});
  ok('an expired one is caught', /expired/.test(v.say));
  ok('a dog with nothing on file is caught', /nothing on file/.test(v.say));
  ok('a current one is not chased', !/Bruno Sala/.test(v.say));
}

console.log('\n--- names render as typed ---');
{
  /* Escaping the key and then letting aRow escape it again is invisible in
     testing with tidy names and very visible the first time a real one has an
     apostrophe in it. */
  reset();
  DB.dogs.push({id:'d8',ownerId:'o1',name:"O'Malley",size:'medium'});
  DB.owners.push({id:'o4',name:'Smith & Daughter',email:'s@x.com'});
  DB.dogs.push({id:'d7',ownerId:'o4',name:"O'Hara",size:'small'});
  const r=await run('find_dogs',{query:"o'"});
  ok('two matches, so the card renders', /Which one\?/.test(r.card));
  ok("an apostrophe is escaped once, not twice", !/&amp;#39;/.test(r.card));
  ok('an ampersand is escaped once, not twice', !/&amp;amp;/.test(r.card));
  ok('and nothing raw gets through', !/<script/.test(r.card));

  const bk=await run('book',{dogId:'d8',dates:['2026-10-22'],session:'full'});
  ok('the booking card is clean too', !/&amp;#39;/.test(bk.card));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
