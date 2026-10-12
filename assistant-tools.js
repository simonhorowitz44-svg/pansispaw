/* Pansi's Paws — what Andressa is allowed to ask for in plain English.
 *
 * The panel and the Cloud Function both import this, for the same reason they
 * both import invoice-core.js: the model is told about a tool in one place and
 * the panel executes it in another, and a tool whose description has drifted
 * from what the code does is a tool that quietly does the wrong thing to live
 * client data. Schemas here, execution in admin-v2.html, and nothing in this
 * file touches the DOM, Firestore or the network so it can be unit-tested.
 *
 * TIERS decide what happens after the model picks a tool:
 *
 *   read   answer and show it. Cannot change anything.
 *   write  do it immediately, then offer Undo in the same card. Everything in
 *          this tier must be reversible by one tap — that is the whole reason
 *          it is safe to skip a confirmation.
 *   send   never executed by the model. The panel renders what would go out
 *          and waits for a tap, because an email cannot be taken back.
 *
 * Adding a tool means deciding its tier first. If you cannot write the Undo,
 * it is not a write.
 */

export const TIERS = { READ: 'read', WRITE: 'write', SEND: 'send' };

/* Deliberately absent, and not an oversight: deleteDog, deleteOwner,
   applyMergeDog, applyMergeOwner. Those destroy records with no undo, and
   this panel has already lost client data once this year. They stay on the
   buttons, where a human has to mean it. */

export const TOOLS = [
  /* ---------- read ---------- */
  {
    name: 'find_dogs',
    tier: TIERS.READ,
    description:
      "Look up dogs by name, breed, or owner name. Use this whenever a message names a dog, "
      + "before any booking or cancellation, so you are working from a real id. Returns every "
      + "match — if more than one comes back, ask Andressa which she means rather than guessing.",
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: "Dog name, owner name, or part of one." } },
      required: ['query']
    }
  },
  {
    name: 'day',
    tier: TIERS.READ,
    description:
      "What is booked on a date or across a range: dogs, session types, arrival times, what each dog "
      + "is being charged, the day's total, and how much room is left. Use this for 'what's on Thursday', "
      + "'how much are we taking tomorrow', 'what's this week worth'. Scouts is capped at four dogs per "
      + "trip by NSW law, so say when a trip is full. Every figure comes from the invoicing code — "
      + "report the numbers it returns and never add them up yourself.",
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD.' },
        to:   { type: 'string', description: 'YYYY-MM-DD. Omit for a single day.' }
      },
      required: ['from']
    }
  },
  {
    name: 'quote',
    tier: TIERS.READ,
    description:
      "What a session would cost for a particular dog, before anything is booked. Prices depend on the "
      + "dog's size, so this needs a dogId from find_dogs. Use for 'what would three nights cost for Lola', "
      + "'how much is a full day for a big dog'. This only quotes — it books nothing.",
    input_schema: {
      type: 'object',
      properties: {
        dogId:   { type: 'string' },
        session: { type: 'string', enum: ['meet','trial','half','extended','full','overnight','scouts'] },
        count:   { type: 'number', description: 'How many days or nights. Defaults to 1.' }
      },
      required: ['dogId','session']
    }
  },
  {
    name: 'owes',
    tier: TIERS.READ,
    description:
      "Who has unpaid visits and how much, oldest first. Use for 'who hasn't paid', "
      + "'what am I owed', 'is anyone overdue'.",
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'invoice_state',
    tier: TIERS.READ,
    description:
      "Whether a client's invoice can go out, and if not, exactly why. Three answers: ready, "
      + "waiting (they still have a booking later this week, so billing now would mean two emails), "
      + "or blocked (something is wrong and a person must fix it). Always use this before send_invoice, "
      + "and use it to answer 'why isn't X's invoice generating'.",
    input_schema: {
      type: 'object',
      properties: { ownerId: { type: 'string' } },
      required: ['ownerId']
    }
  },
  {
    name: 'stay',
    tier: TIERS.READ,
    description:
      "A boarding stay and its deposit: nights, full price, deposit asked for, whether it has been "
      + "paid, and the three cancellation dates. Deposits are only taken on stays of three nights or more.",
    input_schema: {
      type: 'object',
      properties: { dogId: { type: 'string' } },
      required: ['dogId']
    }
  },

  /* ---------- write · each one undoable in a tap ---------- */
  {
    name: 'book',
    tier: TIERS.WRITE,
    description:
      "Put a dog in the diary. Takes several dates at once for a repeat. Never call this without a "
      + "dogId from find_dogs. If the dog is already booked that day in that session it is a duplicate, "
      + "not a second visit, and will be refused.",
    input_schema: {
      type: 'object',
      properties: {
        dogId:   { type: 'string' },
        dates:   { type: 'array', items: { type: 'string' }, description: 'YYYY-MM-DD, one or more.' },
        session: { type: 'string', enum: ['meet','trial','half','extended','full','overnight','scouts'],
                   description: "meet and trial are free. overnight is boarding. Default to full if she doesn't say." },
        scoutsTrip:  { type: 'string', enum: ['am','pm'], description: 'Scouts only.' },
        arrivalTime: { type: 'string', description: 'HH:MM, optional.' },
        departureTime: { type: 'string', description: 'HH:MM, optional.' },
        note: { type: 'string' }
      },
      required: ['dogId','dates','session']
    }
  },
  {
    name: 'check_in',
    tier: TIERS.WRITE,
    description:
      "Mark dogs as arrived. This is the most frequent thing Andressa does — most mornings she will "
      + "say something like 'everyone's here' or 'they all arrived at 8'. Pass all:true to do every dog "
      + "booked that day, or dogIds for specific ones. Dogs already marked in are left alone and reported, "
      + "not stamped twice.",
    input_schema: {
      type: 'object',
      properties: {
        all:    { type: 'boolean', description: 'Every dog booked that day.' },
        dogIds: { type: 'array', items: { type: 'string' }, description: 'Specific dogs, from find_dogs.' },
        time:   { type: 'string', description: 'HH:MM. Defaults to now.' },
        date:   { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' }
      },
      required: []
    }
  },
  {
    name: 'check_out',
    tier: TIERS.WRITE,
    description:
      "Mark dogs as collected. A late pickup carries a fee, which is worked out by the invoicing code "
      + "and must be reported plainly — Andressa often means to waive it. Pass all:true for everyone "
      + "still here, or dogIds. Dogs not yet marked in are reported rather than guessed at.",
    input_schema: {
      type: 'object',
      properties: {
        all:    { type: 'boolean', description: 'Every dog still marked as here.' },
        dogIds: { type: 'array', items: { type: 'string' } },
        time:   { type: 'string', description: 'HH:MM. Defaults to now.' },
        date:   { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        waiveLateFee: { type: 'boolean', description: 'Only if Andressa has actually said to waive it.' }
      },
      required: []
    }
  },
  {
    name: 'cancel',
    tier: TIERS.WRITE,
    description:
      "Cancel a booking. More than 24 hours' notice is free; inside 24 hours is charged at half the "
      + "rate, per the terms. Say plainly when a charge has been applied — Andressa often means to waive it. "
      + "Set waive true only if she has actually said so.",
    input_schema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string' },
        waive: { type: 'boolean', description: 'Cancel with no charge even inside 24 hours.' }
      },
      required: ['bookingId']
    }
  },
  {
    name: 'add_dog',
    tier: TIERS.WRITE,
    description:
      "Add a new dog, and its owner if they are new too. Records are matched on email, so a client "
      + "without one can never be matched to a payment later — ask for it. Check find_dogs first so an "
      + "existing client does not get a duplicate record.",
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string' },
        size:    { type: 'string', enum: ['small','medium','large'], description: 'Decides every price.' },
        breed:   { type: 'string' },
        ownerId: { type: 'string', description: 'For an existing client. Otherwise give ownerName.' },
        ownerName:  { type: 'string' },
        ownerEmail: { type: 'string' },
        ownerPhone: { type: 'string' },
        notes:   { type: 'string', description: 'Allergies, vet, behaviour — anything she says.' }
      },
      required: ['name','size']
    }
  },
  {
    name: 'sell_pack',
    tier: TIERS.WRITE,
    description:
      "Record a prepaid pack of days for a dog. Packs are paid up front and discounted, and the price "
      + "comes from the pricing code — only pass paidAmount if Andressa agreed a different figure.",
    input_schema: {
      type: 'object',
      properties: {
        dogId: { type: 'string' },
        size:  { type: 'number', description: 'How many days, usually 5 or 10.' },
        paidAmount: { type: 'number', description: 'Only if it differs from the standard price.' },
        expiryDate: { type: 'string', description: 'YYYY-MM-DD. Defaults to six months out.' },
        notes: { type: 'string' }
      },
      required: ['dogId','size']
    }
  },
  {
    name: 'record_deposit',
    tier: TIERS.WRITE,
    description:
      "Create the deposit for a boarding stay, so it can then be requested. Half the stay by default, "
      + "and only on stays of three nights or more. Use deposit_received once the money arrives.",
    input_schema: {
      type: 'object',
      properties: {
        dogId:  { type: 'string' },
        amount: { type: 'number', description: 'Only if Andressa agreed something other than half.' }
      },
      required: ['dogId']
    }
  },
  {
    name: 'mark_invoice_paid',
    tier: TIERS.WRITE,
    description:
      "Mark an invoice that was already emailed as paid. This is for reconciling the bank — use "
      + "record_payment instead when the money is against a week rather than a specific invoice number.",
    input_schema: {
      type: 'object',
      properties: { number: { type: 'string', description: 'The invoice number, e.g. PP-20261012-A7DB.' } },
      required: ['number']
    }
  },
  {
    name: 'set_price',
    tier: TIERS.WRITE,
    description:
      "Override what a single booking costs — a deal, a discount, a correction. Pass null to put it back "
      + "to the standard price for that dog's size. Say the old and new figure plainly.",
    input_schema: {
      type: 'object',
      properties: {
        bookingId: { type: 'string' },
        price:     { type: ['number','null'], description: 'Dollars, or null to reset.' },
        reason:    { type: 'string' }
      },
      required: ['bookingId']
    }
  },
  {
    name: 'vaccinations_due',
    tier: TIERS.READ,
    description:
      "Dogs whose vaccination is missing, expired, or expiring soon. A compliance chore nobody "
      + "remembers until it matters.",
    input_schema: {
      type: 'object',
      properties: { withinDays: { type: 'number', description: 'Defaults to 60.' } },
      required: []
    }
  },
  {
    name: 'uncancel',
    tier: TIERS.WRITE,
    description: 'Reinstate a cancelled booking and drop any cancellation charge.',
    input_schema: { type: 'object', properties: { bookingId: { type: 'string' } }, required: ['bookingId'] }
  },
  {
    name: 'record_payment',
    tier: TIERS.WRITE,
    description:
      "Record money received from a client. It is credited against their oldest unpaid invoice "
      + "automatically. Use for 'Frankie paid', 'Celine sent $180 yesterday'.",
    input_schema: {
      type: 'object',
      properties: {
        ownerId: { type: 'string' },
        amount:  { type: 'number', description: 'Dollars.' },
        date:    { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        method:  { type: 'string', description: 'bank, cash, card. Defaults to bank.' }
      },
      required: ['ownerId','amount']
    }
  },
  {
    name: 'deposit_received',
    tier: TIERS.WRITE,
    description:
      "Mark a boarding deposit as paid. This turns the deposit request document into a receipt, "
      + "which can then be sent with send_deposit.",
    input_schema: {
      type: 'object',
      properties: {
        depositId: { type: 'string' },
        amount: { type: 'number', description: 'Defaults to the full deposit asked for.' }
      },
      required: ['depositId']
    }
  },

  /* ---------- send · proposed only, never executed ---------- */
  {
    name: 'send_invoice',
    tier: TIERS.SEND,
    description:
      "Propose sending a client their invoice. Check invoice_state first. Set now true only if "
      + "Andressa has explicitly asked to bill mid-week, overriding the wait for the week to finish.",
    input_schema: {
      type: 'object',
      properties: {
        ownerId: { type: 'string' },
        now: { type: 'boolean', description: 'Override the end-of-week wait.' }
      },
      required: ['ownerId']
    }
  },
  {
    name: 'send_receipt',
    tier: TIERS.SEND,
    description:
      "Propose sending a receipt for a week already paid in full. A document is a receipt only once "
      + "a payment has been recorded against the week and the total has reached zero — asking for one "
      + "does not make it one. If the client has paid but it was never entered, call record_payment "
      + "first and the same document becomes the receipt. Never fall back to sending an invoice to "
      + "someone who has already paid.",
    input_schema: { type: 'object', properties: { ownerId: { type: 'string' } }, required: ['ownerId'] }
  },
  {
    name: 'send_all_ready',
    tier: TIERS.SEND,
    description:
      "Propose sending every invoice that is ready to go — the batch at the end of the week. Clients "
      + "who are waiting or blocked are excluded automatically and reported, not sent.",
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'send_deposit',
    tier: TIERS.SEND,
    description:
      "Propose sending a boarding deposit request, or — once deposit_received has been recorded — "
      + "the receipt for it. Same document either way.",
    input_schema: {
      type: 'object',
      properties: {
        depositId: { type: 'string' },
        receipt: { type: 'boolean', description: 'True once the money is in.' }
      },
      required: ['depositId']
    }
  }
];

export const toolByName = name => TOOLS.find(t => t.name === name) || null;
export const tierOf     = name => (toolByName(name) || {}).tier || null;
/* What goes to the model: the schema fields only. The tier is ours. */
export const apiTools   = () => TOOLS.map(({ name, description, input_schema }) =>
                                           ({ name, description, input_schema }));

/* ---------- the system prompt ---------- */

/* Written for Andressa, who is running this one-handed between dogs. The
   failure mode to design against is not the model refusing — it is the model
   being agreeable about something it got wrong. Hence: never guess a dog,
   never invent a price, say when money changed. */
export function systemPrompt(ctx = {}) {
  return `You are the assistant inside the Pansi's Paws admin panel. You are talking to Andressa Ubida Fernandes, who runs the business and does all the dog care herself. She is usually on her phone, often mid-handover, and wants the answer rather than a conversation about the answer.

Today is ${ctx.today}${ctx.weekday ? ` (${ctx.weekday})` : ''}. All money is Australian dollars. Dates you report should read like "Thu 15 Oct", not ISO.

HOW TO ANSWER
Short. One or two sentences, then the tool result speaks for itself — the panel renders the data as a card, so do not repeat the numbers back in prose. No preamble, no "I'd be happy to", no summary of what you just did. If something is fine, say so in a handful of words.

RESOLVING DOGS AND CLIENTS
Always find_dogs before acting on a name. Several dogs share a name — there are three called Luna. If more than one matches, stop and ask which, and do not write anything. Getting this wrong means a dog arrives that nobody expected.

MONEY
Never calculate a price, a fee or a total yourself — not even adding up a column that is already in front of you. The tools return figures from the invoicing code and those are the only numbers you may state. The day tool gives you each dog's charge and the day's total; quote gives you the price of a session that has not been booked yet. If you want a number and no tool gave it to you, call a tool rather than working it out.

Prices depend on the dog's size, so a question like "what do we charge for a full day" has no single answer — quote it for the dog in question, or say that it depends on size and give the range the tool returns.

When something you did costs a client money — a late cancellation charge, mainly — say so plainly in the same breath. Andressa frequently intends to waive those, and she can only do that if she knows.

RECEIPTS
A receipt and an invoice are the same document in two states, and what decides which is whether a payment has been recorded. If Andressa says someone has already paid, the payment almost certainly has not been entered yet — record it, then send. Never send an invoice to a client she has told you has paid, and never describe a document as a receipt while it still asks for money.

SENDING
You cannot send anything. The send tools propose; Andressa taps. Never tell her something has been sent. If an invoice is blocked, the reason comes from the invoicing code — report it exactly, and do not look for a way around it.

THE RULES OF THE BUSINESS
Scouts Club takes a hard maximum of four dogs per trip. That is NSW law on effective control in a public place, not a preference, and it cannot be stretched for one more dog.

Boarding is daycare-only overnight for existing clients; the business cannot advertise or expand it. Deposits are taken on stays of three nights or more, at half the stay. Cancelling a boarding stay: full refund more than four weeks out, credit from four to two weeks, kept inside two weeks. Ordinary daycare cancellations are free beyond 24 hours and half the rate inside it.

Invoices wait until a client's last booking of the week is done, so they get one email instead of three. A client "waiting" is not a client with a problem — say so, and offer the mid-week override rather than treating it as a fault.

WHEN YOU ARE NOT SURE
Say so and ask. A wrong booking is worse than a question. Andressa would far rather be asked which Luna than find out on Thursday morning.`;
}
