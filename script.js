// Pansi's Paw Home Daycare - Site Scripts

function initScrollAnimations() {
  const animated = document.querySelectorAll('.animate-on-scroll');
  if (!animated.length) return;
  const observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) entry.target.classList.add('in-view');
    });
  }, { rootMargin: '0px 0px -40px 0px', threshold: 0.1 });
  animated.forEach(function(el) { observer.observe(el); });
}

document.addEventListener('DOMContentLoaded', function() {
  initScrollAnimations();

  const header = document.querySelector('.header');
  const menuBtn = document.querySelector('.mobile-menu-btn');
  const navLinks = document.querySelectorAll('.nav a');

  if (menuBtn && header) {
    menuBtn.addEventListener('click', function() {
      header.classList.toggle('nav-open');
      menuBtn.setAttribute('aria-label', header.classList.contains('nav-open') ? 'Close menu' : 'Open menu');
      menuBtn.textContent = header.classList.contains('nav-open') ? '✕' : '☰';
    });
  }

  navLinks.forEach(function(link) {
    link.addEventListener('click', function() {
      if (header && header.classList.contains('nav-open')) {
        header.classList.remove('nav-open');
        if (menuBtn) menuBtn.textContent = '☰';
      }
    });
  });

  // Enrolment form submits to Formspree, then redirects to ?submitted=1

  // Meet section: Read more → modal (Andressa & Pansi)
  function openModal(modalEl, closeBtn) {
    if (modalEl) {
      modalEl.classList.add('is-open');
      modalEl.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      if (closeBtn) closeBtn.focus();
    }
  }

  function closeModal(modalEl, focusBtn) {
    if (modalEl) {
      modalEl.classList.remove('is-open');
      modalEl.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (focusBtn) focusBtn.focus();
    }
  }

  const andressaModal = document.getElementById('andressaModal');
  const andressaReadMore = document.getElementById('meetReadMore');
  const andressaClose = document.getElementById('modalClose');
  const andressaOverlay = document.getElementById('modalOverlay');

  if (andressaReadMore && andressaModal) {
    andressaReadMore.addEventListener('click', function(e) {
      e.preventDefault();
      openModal(andressaModal, andressaClose);
    });
  }
  if (andressaOverlay) andressaOverlay.addEventListener('click', function() { closeModal(andressaModal, andressaReadMore); });
  if (andressaClose) andressaClose.addEventListener('click', function() { closeModal(andressaModal, andressaReadMore); });

  const pansiModal = document.getElementById('pansiModal');
  const pansiReadMore = document.getElementById('pansiReadMore');
  const pansiClose = document.getElementById('pansiModalClose');
  const pansiOverlay = document.getElementById('pansiModalOverlay');

  if (pansiReadMore && pansiModal) {
    pansiReadMore.addEventListener('click', function(e) {
      e.preventDefault();
      openModal(pansiModal, pansiClose);
    });
  }
  if (pansiOverlay) pansiOverlay.addEventListener('click', function() { closeModal(pansiModal, pansiReadMore); });
  if (pansiClose) pansiClose.addEventListener('click', function() { closeModal(pansiModal, pansiReadMore); });

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (andressaModal && andressaModal.classList.contains('is-open')) closeModal(andressaModal, andressaReadMore);
    if (pansiModal && pansiModal.classList.contains('is-open')) closeModal(pansiModal, pansiReadMore);
  });
});
