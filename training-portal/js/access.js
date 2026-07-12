/**
 * access.js — GuideHerd Academy client-side access layer
 *
 * Access decisions are made server-side by GET /api/access.
 * This script reads that response and shows or hides content accordingly.
 * It never grants access on its own — the server decides.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var _accessCache = null; // { authenticated, hasAccess, plan, subscriptionStatus }

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async function fetchAccess() {
  if (_accessCache) return _accessCache;
  try {
    var res = await fetch('/api/access');
    if (!res.ok) throw new Error('access api ' + res.status);
    _accessCache = await res.json();
  } catch (_) {
    // On network error, default to no access — never fail open
    _accessCache = { authenticated: false, hasAccess: false, plan: null, subscriptionStatus: null };
  }
  return _accessCache;
}

// ---------------------------------------------------------------------------
// User display
// ---------------------------------------------------------------------------

async function initUserDisplay() {
  var el = document.getElementById('user-display');
  if (!el) return;
  try {
    var res = await fetch('/api/me');
    if (!res.ok) return;
    var data = await res.json();
    if (data.authenticated && data.user) {
      el.textContent = data.user.name || data.user.email;
      el.style.display = 'inline';
    }
  } catch (_) {
    // Silently ignore — header display is non-critical
  }
}

// ---------------------------------------------------------------------------
// Paywall (lesson pages)
// ---------------------------------------------------------------------------

async function initPaywall() {
  var content = document.getElementById('lesson-content');
  var gate    = document.getElementById('paywall-gate');
  var loading = document.getElementById('access-loading');

  if (!content || !gate) return;

  var access = await fetchAccess();

  if (loading) loading.style.display = 'none';

  if (access.hasAccess) {
    content.classList.add('visible');
    gate.classList.remove('visible');
  } else {
    content.classList.remove('visible');
    gate.classList.add('visible');
  }
}

// ---------------------------------------------------------------------------
// Dashboard (academy/index.html)
// ---------------------------------------------------------------------------

async function initDashboard() {
  var gate = document.getElementById('dashboard-gate');
  var dash = document.getElementById('dashboard-content');
  if (!gate || !dash) return;

  var access = await fetchAccess();

  if (access.hasAccess) {
    dash.style.display = 'block';
    gate.style.display = 'none';
  } else {
    dash.style.display = 'none';
    gate.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  initUserDisplay();
  initPaywall();
  initDashboard();
});
