// Pansi's Paw - Enrolment form validation and UX

document.addEventListener('DOMContentLoaded', function() {
  const form = document.getElementById('enrolForm');
  if (!form) return;

  var errorIds = ['error-dogName', 'error-breed', 'error-vaccinated', 'error-ownerName', 'error-ownerPhone', 'error-ownerEmail', 'error-agreementSig', 'error-agreementDate'];

  function clearEnrolErrors() {
    form.querySelectorAll('.form-group').forEach(function(g) { g.classList.remove('has-error'); });
    errorIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = '';
    });
    form.querySelectorAll('input[aria-invalid], textarea[aria-invalid]').forEach(function(i) { i.setAttribute('aria-invalid', 'false'); });
  }

  function setEnrolError(fieldId, message) {
    var group = document.getElementById('group-' + fieldId);
    var errEl = document.getElementById('error-' + fieldId);
    var input = document.getElementById(fieldId);
    if (group) group.classList.add('has-error');
    if (errEl) errEl.textContent = message;
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  form.addEventListener('submit', function(e) {
    clearEnrolErrors();

    var dogName = (document.getElementById('dogName')?.value || '').trim();
    var breed = (document.getElementById('breed')?.value || '').trim();
    var vaccinated = document.querySelector('input[name="vaccinated"]:checked');
    var ownerName = (document.getElementById('ownerName')?.value || '').trim();
    var ownerPhone = (document.getElementById('ownerPhone')?.value || '').trim();
    var ownerEmail = (document.getElementById('ownerEmail')?.value || '').trim();
    var agreementSig = (document.getElementById('agreementSig')?.value || '').trim();
    var agreementDate = (document.getElementById('agreementDate')?.value || '').trim();

    var firstInvalid = null;

    if (!dogName) { setEnrolError('dogName', 'Please enter your dog\'s name.'); if (!firstInvalid) firstInvalid = document.getElementById('dogName'); }
    if (!breed) { setEnrolError('breed', 'Please enter or select breed.'); if (!firstInvalid) firstInvalid = document.getElementById('breed'); }
    if (!vaccinated) { setEnrolError('vaccinated', 'Please select vaccination status.'); if (!firstInvalid) firstInvalid = document.querySelector('input[name="vaccinated"]'); }
    if (!ownerName) { setEnrolError('ownerName', 'Please enter owner full name.'); if (!firstInvalid) firstInvalid = document.getElementById('ownerName'); }
    if (!ownerPhone) { setEnrolError('ownerPhone', 'Please enter phone number.'); if (!firstInvalid) firstInvalid = document.getElementById('ownerPhone'); }
    if (!ownerEmail) { setEnrolError('ownerEmail', 'Please enter email.'); if (!firstInvalid) firstInvalid = document.getElementById('ownerEmail'); }
    if (!agreementSig) { setEnrolError('agreementSig', 'Please provide signature.'); if (!firstInvalid) firstInvalid = document.getElementById('agreementSig'); }
    if (!agreementDate) { setEnrolError('agreementDate', 'Please enter date.'); if (!firstInvalid) firstInvalid = document.getElementById('agreementDate'); }

    if (firstInvalid) {
      e.preventDefault();
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    var btn = document.getElementById('enrolSubmit');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  });

  form.querySelectorAll('input, textarea').forEach(function(input) {
    input.addEventListener('input', clearEnrolErrors);
    input.addEventListener('change', clearEnrolErrors);
  });
});
