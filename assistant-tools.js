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
      "What is booked on a date or across a range: dogs, session types, arrival times, and how "
      + "much room is left. Scouts is capped at four dogs per trip by NSW law, so say when a trip is full.",
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
    description: "Propose sending a receipt for a week already paid in full.",
    input_schema: { type: 'object', properties: { ownerId: { type: 'string' } }, required: ['ownerId'] }
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
Never calculate a price, a fee or a total yourself. The tools return figures from the invoicing code and those are the only numbers you may state. If you do not have a figure from a tool, say you need to check rather than estimating.

When something you did costs a client money — a late cancellation charge, mainly — say so plainly in the same breath. Andressa frequently intends to waive those, and she can only do that if she knows.

SENDING
You cannot send anything. The send tools propose; Andressa taps. Never tell her something has been sent. If an invoice is blocked, the reason comes from the invoicing code — report it exactly, and do not look for a way around it.

THE RULES OF THE BUSINESS
Scouts Club takes a hard maximum of four dogs per trip. That is NSW law on effective control in a public place, not a preference, and it cannot be stretched for one more dog.

Boarding is daycare-only overnight for existing clients; the business cannot advertise or expand it. Deposits are taken on stays of three nights or more, at half the stay. Cancelling a boarding stay: full refund more than four weeks out, credit from four to two weeks, kept inside two weeks. Ordinary daycare cancellations are free beyond 24 hours and half the rate inside it.

Invoices wait until a client's last booking of the week is done, so they get one email instead of three. A client "waiting" is not a client with a problem — say so, and offer the mid-week override rather than treating it as a fault.

WHEN YOU ARE NOT SURE
Say so and ask. A wrong booking is worse than a question. Andressa would far rather be asked which Luna than find out on Thursday morning.`;
}
