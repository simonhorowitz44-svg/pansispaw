// Pansi's Paw - Booking Flow Logic

// ─── STRIPE PAYMENT LINKS ───────────────────────────────────────────────────
// Paste your Stripe Payment Link URLs below. Create a payment link for each product
// (Stripe → Product → ⋯ → Create payment link). Redirect: book.html?paid=1
//
// SINGLE-DAY (6 products):
//   small half  = Day care – Small, half-day   $45
//   small full  = Day care – Small, full-day   $70
//   medium half = Day care – Medium, half-day $55
//   medium full = Day care – Medium, full-day $80
//   large half  = Day care – Large, half-day   $60
//   large full  = Day care – Large, full-day   $90
//
// PACKS (6 products):
//   5-day  Small $315 | Medium $360 | Large $405
//   10-day Small $595 | Medium $680 | Large $765
//
// NOTE: Stripe payment links temporarily disabled (set to '#') because they were
// configured for the old prices ($45/$55/$60 half, $70/$80/$90 full) and
// pre-paid 5/10-day packs at the old per-day rates. Until new Stripe products
// are created at the May 2026 prices ($50/$65/$70 half, $80/$90/$100 full;
// 5-day pack $360/$405/$450; 10-day pack $680/$765/$850), all bookings flow
// through Formspree and Andressa confirms + takes payment by phone.
// Old Stripe URLs preserved below in commented form for re-enable once updated.
var PAYMENT_LINKS = {
  small:  { half: '#', full: '#' },
  medium: { half: '#', full: '#' },
  large:  { half: '#', full: '#' }
};
var PACK_LINKS = {
  '5day':  { small: '#', medium: '#', large: '#' },
  '10day': { small: '#', medium: '#', large: '#' }
};
// var PAYMENT_LINKS_OLD = {
//   small:  { half: 'https://buy.stripe.com/9B64gA8009ePfM16vM1440b', full: 'https://buy.stripe.com/fZudRad4EfDd0R79HY1440a' },
//   medium: { half: 'https://buy.stripe.com/aFa8wQaWw62DbvLcUa14409', full: 'https://buy.stripe.com/9B63cw3u40IjeHXg6m14408' },
//   large:  { half: 'https://buy.stripe.com/fZudRa0hS3Uv0R7g6m14407', full: 'https://buy.stripe.com/3cIbJ2fcM62D6br6vM14406' }
// };
// var PACK_LINKS_OLD = {
//   '5day':  { small: 'https://buy.stripe.com/dRmaEY4y89ePeHXg6m14405', medium: 'https://buy.stripe.com/4gMeVe2q0dv5bvL5rI14404', large: 'https://buy.stripe.com/3cI5kE0hS62D8jz07014403' },
//   '10day': { small: 'https://buy.stripe.com/3cIaEYggQez9arH07014402', medium: 'https://buy.stripe.com/5kQ28s2q03Uv57naM214401', large: 'https://buy.stripe.com/4gMeVefcMbmX7fv5rI14400' }
// };

document.addEventListener('DOMContentLoaded', function() {
  const form = document.getElementById('bookingForm');
  const dateInput = document.getElementById('bookingDate');
  const sizeCards = document.querySelectorAll('.size-card');
  const sessionInputs = document.querySelectorAll('input[name="session"]');
  const halfPriceEl = document.getElementById('halfPrice');
  const fullPriceEl = document.getElementById('fullPrice');
  const summaryDate = document.getElementById('summaryDate');
  const summarySession = document.getElementById('summarySession');
  const summaryTotal = document.getElementById('summaryTotal');
  const summaryTotalLabel = document.getElementById('summaryTotalLabel');
  const availabilityNote = document.getElementById('availabilityNote');

  // Set min date to today
  const today = new Date().toISOString().split('T')[0];
  if (dateInput) dateInput.setAttribute('min', today);

  // Simulated unavailable dates (example: fully booked or closed)
  const unavailableDates = ['2026-12-25', '2026-12-26', '2027-01-01'];

  // Simulate some random weekdays as fully booked for demo
  function isDateUnavailable(dateStr) {
    if (!dateStr) return false;
    if (unavailableDates.includes(dateStr)) return true;
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay();
    if (day === 0 || day === 6) return true; // Weekends
    return false;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function updatePrices() {
    const selectedSize = document.querySelector('input[name="size"]:checked');
    if (!selectedSize) {
      halfPriceEl.textContent = '—';
      fullPriceEl.textContent = '—';
      return;
    }
    const card = selectedSize.closest('.size-card');
    halfPriceEl.textContent = '$' + card.dataset.half;
    fullPriceEl.textContent = '$' + card.dataset.full;
  }

  function updateSummary() {
    const selectedSize = document.querySelector('input[name="size"]:checked');
    const selectedSession = document.querySelector('input[name="session"]:checked');
    const date = dateInput.value;

    summaryDate.textContent = formatDate(date);
    if (selectedSize && selectedSession) {
      const card = selectedSize.closest('.size-card');
      var sessionVal = selectedSession.value;
      var labels = { half: 'Half-day', full: 'Full-day', '5day': '5-day pack', '10day': '10-day pack' };
      summarySession.textContent = labels[sessionVal] || sessionVal;
      var price = sessionVal === 'half' ? card.dataset.half : sessionVal === 'full' ? card.dataset.full : sessionVal === '5day' ? card.dataset.pack5 : card.dataset.pack10;
      summaryTotal.textContent = '$' + price;
      if (summaryTotalLabel) summaryTotalLabel.textContent = (sessionVal === 'half' || sessionVal === 'full') ? '(one day)' : '';
    } else {
      summarySession.textContent = '—';
      summaryTotal.textContent = '—';
      if (summaryTotalLabel) summaryTotalLabel.textContent = '(one day)';
    }
  }

  function checkAvailability() {
    const date = dateInput.value;
    if (!date) {
      availabilityNote.textContent = '';
      availabilityNote.className = 'availability-note';
      return;
    }
    if (isDateUnavailable(date)) {
      availabilityNote.textContent = 'This date may be unavailable. Andressa will confirm when you book.';
      availabilityNote.className = 'availability-note unavailable';
    } else {
      availabilityNote.textContent = 'Date appears available. Booking will be confirmed by phone.';
      availabilityNote.className = 'availability-note available';
    }
  }

  sizeCards.forEach(card => {
    card.addEventListener('click', function() {
      updatePrices();
      updateSummary();
    });
  });

  sessionInputs.forEach(input => {
    input.addEventListener('change', updateSummary);
  });

  if (dateInput) {
    dateInput.addEventListener('change', function() {
      checkAvailability();
      updateSummary();
    });
  }

  // Initial state
  updatePrices();
  updateSummary();

  function clearBookingErrors() {
    document.getElementById('section-size')?.classList.remove('has-error');
    document.getElementById('section-date')?.classList.remove('has-error');
    ['error-size', 'error-date', 'error-bookName', 'error-bookPhone', 'error-bookDog'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el) { el.textContent = ''; }
    });
    document.querySelectorAll('#bookingForm .form-group').forEach(function(g) { g.classList.remove('has-error'); });
    document.querySelectorAll('#bookingForm input[aria-invalid]').forEach(function(i) { i.setAttribute('aria-invalid', 'false'); });
  }

  function showBookingError(id, message) {
    const el = document.getElementById(id);
    if (el) el.textContent = message;
    if (id === 'error-size') document.getElementById('section-size')?.classList.add('has-error');
    if (id === 'error-date') document.getElementById('section-date')?.classList.add('has-error');
    const group = document.getElementById('group-' + id.replace('error-', ''));
    if (group) { group.classList.add('has-error'); group.querySelector('input')?.setAttribute('aria-invalid', 'true'); }
  }

  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      clearBookingErrors();
      const size = document.querySelector('input[name="size"]:checked');
      const date = dateInput?.value?.trim();
      const name = document.getElementById('bookName')?.value?.trim();
      const phone = document.getElementById('bookPhone')?.value?.trim();
      const dog = document.getElementById('bookDog')?.value?.trim();

      var firstInvalid = null;
      if (!size) {
        showBookingError('error-size', 'Please select your dog\'s size.');
        if (!firstInvalid) firstInvalid = document.querySelector('input[name="size"]');
      }
      if (!date) {
        showBookingError('error-date', 'Please choose a date.');
        if (!firstInvalid) firstInvalid = dateInput;
      }
      if (!name) {
        showBookingError('error-bookName', 'Please enter your name.');
        if (!firstInvalid) firstInvalid = document.getElementById('bookName');
      }
      if (!phone) {
        showBookingError('error-bookPhone', 'Please enter your phone number.');
        if (!firstInvalid) firstInvalid = document.getElementById('bookPhone');
      }
      if (!dog) {
        showBookingError('error-bookDog', 'Please enter your dog\'s name.');
        if (!firstInvalid) firstInvalid = document.getElementById('bookDog');
      }

      if (firstInvalid) {
        firstInvalid.focus();
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      var btn = document.getElementById('bookingSubmit');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending request…'; }

      var sessionSel = document.querySelector('input[name="session"]:checked');
      var sessionVal = sessionSel ? sessionSel.value : null;
      var paymentUrl = null;
      if (size && sessionVal) {
        if (sessionVal === 'half' || sessionVal === 'full') {
          paymentUrl = PAYMENT_LINKS[size.value] ? PAYMENT_LINKS[size.value][sessionVal] : null;
        } else if (sessionVal === '5day' || sessionVal === '10day') {
          paymentUrl = PACK_LINKS[sessionVal] ? PACK_LINKS[sessionVal][size.value] : null;
        }
      }
      if (paymentUrl && paymentUrl !== '#') {
        // Send form to Formspree in background (fire-and-forget), redirect immediately
        navigator.sendBeacon(form.action, new FormData(form));
        window.location.href = paymentUrl;
      } else {
        form.submit();
      }
    });
  }

  // Clear inline errors when user corrects
  form?.querySelectorAll('input').forEach(function(input) {
    input.addEventListener('input', clearBookingErrors);
    input.addEventListener('change', clearBookingErrors);
  });
  document.querySelectorAll('input[name="size"]').forEach(function(r) {
    r.addEventListener('change', clearBookingErrors);
  });
});
