/**
 * checkout.js — GuideHerd Academy Stripe Checkout client
 *
 * Sends planKey to POST /api/checkout, which creates the Stripe session
 * server-side and returns a checkoutUrl. The browser is then redirected
 * to Stripe's hosted checkout page.
 *
 * Plan key → Stripe Price ID mapping lives in the server (functions/_lib/plans.ts).
 * No Stripe keys are handled in this file.
 */

// Maps the data-plan-key attributes on subscribe buttons to valid plan keys.
// Must match the PlanKey type in functions/_lib/types.ts.
var PLAN_KEY_MAP = {
  'academy':           { monthly: 'academy_monthly',          annual: 'academy_annual' },
  'academy-plus':      { monthly: 'academy_plus_monthly',     annual: 'academy_plus_annual' },
  'workflow-support':  { monthly: 'workflow_support_monthly', annual: 'workflow_support_annual' },
};

var currentPeriod = 'monthly'; // updated by billing toggle

// ---------------------------------------------------------------------------
// Checkout request
// ---------------------------------------------------------------------------

async function startCheckout(planKey) {
  var btn = document.querySelector('[data-checkout-loading]');
  if (btn) btn.disabled = true;

  try {
    var res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planKey: planKey }),
    });

    var data = await res.json();

    if (!res.ok || !data.checkoutUrl) {
      alert(data.error || 'Could not start checkout. Please try again.');
      if (btn) btn.disabled = false;
      return;
    }

    window.location.href = data.checkoutUrl;
  } catch (_) {
    alert('Network error. Please check your connection and try again.');
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Billing period toggle
// ---------------------------------------------------------------------------

function initBillingToggle() {
  var toggle = document.getElementById('billing-toggle');
  var thumb  = document.getElementById('toggle-thumb');
  if (!toggle) return;

  toggle.addEventListener('click', function () {
    var isAnnual = toggle.getAttribute('aria-pressed') === 'true';
    currentPeriod = isAnnual ? 'monthly' : 'annual';
    toggle.setAttribute('aria-pressed', String(!isAnnual));

    if (thumb) {
      thumb.style.left = currentPeriod === 'annual' ? '23px' : '3px';
      toggle.style.background = currentPeriod === 'annual' ? 'var(--accent)' : 'var(--paper-2)';
    }

    updatePriceDisplay();
  });
}

function updatePriceDisplay() {
  var isAnnual = currentPeriod === 'annual';

  var academyPrice = document.getElementById('academy-price');
  var academyAlt   = document.getElementById('academy-alt');
  var plusPrice    = document.getElementById('plus-price');
  var plusAlt      = document.getElementById('plus-alt');
  var supportPrice = document.getElementById('support-price');
  var supportAlt   = document.getElementById('support-alt');

  if (academyPrice) academyPrice.innerHTML = isAnnual ? '$125<span>/month</span>' : '$149<span>/month</span>';
  if (academyAlt)   academyAlt.textContent  = isAnnual ? 'Billed $1,500/year — save $288' : 'or $1,500/year — save $288';
  if (plusPrice)    plusPrice.innerHTML     = isAnnual ? '$333<span>/month</span>' : '$399<span>/month</span>';
  if (plusAlt)      plusAlt.textContent     = isAnnual ? 'Billed $4,000/year — save $788' : 'or $4,000/year — save $788';
  if (supportPrice) supportPrice.innerHTML  = isAnnual ? '$625<span>/month</span>' : '$750<span>/month</span>';
  if (supportAlt)   supportAlt.textContent  = isAnnual ? 'Billed $7,500/year — save $1,500' : 'or $7,500/year — save $1,500';
}

// ---------------------------------------------------------------------------
// Subscribe button wiring
// ---------------------------------------------------------------------------

function initSubscribeButtons() {
  document.querySelectorAll('[data-plan]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var planSlug = btn.dataset.plan;
      var planGroup = PLAN_KEY_MAP[planSlug];

      if (!planGroup) {
        console.error('[checkout] Unknown plan slug:', planSlug);
        return;
      }

      var planKey = planGroup[currentPeriod];
      btn.setAttribute('data-checkout-loading', '1');
      startCheckout(planKey);
    });
  });
}

// ---------------------------------------------------------------------------
// Customer portal link
// ---------------------------------------------------------------------------

async function openCustomerPortal(event) {
  if (event) event.preventDefault();
  try {
    var res = await fetch('/api/portal', { method: 'POST' });
    var data = await res.json();
    if (!res.ok || !data.portalUrl) {
      alert(data.error || 'Could not open billing portal.');
      return;
    }
    window.location.href = data.portalUrl;
  } catch (_) {
    alert('Network error. Please try again.');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  initBillingToggle();
  initSubscribeButtons();

  var portalBtn = document.getElementById('manage-billing-btn');
  if (portalBtn) portalBtn.addEventListener('click', openCustomerPortal);
});
