/* ─────────────────────────────────────────────────
   payments.js — Stripe payment-link generator
   Creates a pay-by-card link (via the ajayadesign
   FastAPI backend) and stores it in Firebase so the
   client-facing /pay page can track live visits.
   ───────────────────────────────────────────────── */

const CARD_FEE_PERCENT = 0.029;
const CARD_FEE_FIXED = 0.30;

/* ── Fee gross-up (mirrors the backend) ── */
function grossUpCardAmount(net) {
  const gross = (net + CARD_FEE_FIXED) / (1 - CARD_FEE_PERCENT);
  return Math.ceil(gross * 100) / 100;
}

function updatePayPreview() {
  const net = parseFloat(document.getElementById('pay-amount').value) || 0;
  const addFee = document.getElementById('pay-add-fee').checked;
  const total = addFee ? grossUpCardAmount(net) : net;
  const fee = Math.max(0, total - net);
  document.getElementById('pay-net').textContent = formatCurrency(net);
  document.getElementById('pay-fee').textContent = formatCurrency(fee);
  document.getElementById('pay-total').textContent = formatCurrency(total);
}

function resetPaymentForm() {
  document.getElementById('paymentForm').reset();
  document.getElementById('pay-add-fee').checked = true;
  document.getElementById('pay-result').style.display = 'none';
  updatePayPreview();
}

async function createPaymentLink() {
  const btn = document.getElementById('pay-create-btn');
  const result = document.getElementById('pay-result');
  const net = parseFloat(document.getElementById('pay-amount').value) || 0;
  const description = document.getElementById('pay-description').value.trim();
  const clientName = document.getElementById('pay-client-name').value.trim();
  const clientPhone = document.getElementById('pay-client-phone').value.trim();
  const addFee = document.getElementById('pay-add-fee').checked;

  if (net <= 0) { alert('Enter an amount greater than 0.'); return; }
  if (!description) { alert('Enter a description.'); return; }

  if (!PAYMENTS_CONFIG.apiBase || PAYMENTS_CONFIG.apiBase.startsWith('__')) {
    alert('Payment API not configured. Set PAYMENT_API_BASE and PAYMENT_ADMIN_TOKEN.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const resp = await fetch(PAYMENTS_CONFIG.apiBase.replace(/\/$/, '') + '/api/v1/payments/create-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': PAYMENTS_CONFIG.adminToken
      },
      body: JSON.stringify({
        amount_net: net,
        description: description,
        client_name: clientName || null,
        client_phone: clientPhone || null,
        add_fee: addFee
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || ('HTTP ' + resp.status));

    // Store in Firebase — creates a tracked /pay/?id= page.
    const record = {
      stripe_url: data.url,
      stripe_link_id: data.payment_link_id,
      amount_net: data.amount_net,
      fee: data.fee,
      amount_total: data.amount_total,
      description: data.description,
      client_name: clientName || '',
      client_phone: clientPhone || '',
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: (currentUser && currentUser.email) || 'admin'
    };
    const ref = await fbPush('/payment_links/', record);
    const trackId = ref.key;
    const payPageUrl = PAYMENTS_CONFIG.siteBase + '/pay/?id=' + trackId;

    if (typeof logActivity === 'function') {
      logActivity('payment_link', 'Created payment link — ' + formatCurrency(data.amount_total) + ' (' + description + ')');
    }

    renderPaymentResult(payPageUrl, data, clientPhone, description);
    refreshPaymentLinks();
  } catch (err) {
    result.style.display = 'block';
    result.innerHTML = '<div style="color:var(--red);background:rgba(239,83,80,0.1);padding:12px;border-radius:10px;">' +
      '✗ ' + (err.message || err) + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Link';
  }
}

function renderPaymentResult(payPageUrl, data, phone, description) {
  const result = document.getElementById('pay-result');
  const smsBody = encodeURIComponent(
    'Hi! Here is your secure payment link for ' + description + ' (' +
    formatCurrency(data.amount_total) + '): ' + payPageUrl
  );
  const smsHref = phone ? 'sms:' + phone.replace(/[^0-9+]/g, '') + '?&body=' + smsBody : 'sms:?&body=' + smsBody;

  result.style.display = 'block';
  result.innerHTML =
    '<div style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);padding:14px;border-radius:10px;">' +
      '<p style="color:var(--green-light);font-weight:600;margin-bottom:8px;">✓ Link ready — client pays ' + formatCurrency(data.amount_total) + '</p>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">' +
        '<input type="text" id="pay-link-out" readonly value="' + payPageUrl + '" ' +
          'style="flex:1;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.85rem;">' +
        '<button class="btn btn-outline btn-sm" onclick="copyPayLink()">Copy</button>' +
      '</div>' +
      '<div class="btn-group">' +
        '<a class="btn btn-primary btn-sm" href="' + smsHref + '">📱 Text to client</a>' +
        '<a class="btn btn-outline btn-sm" href="' + payPageUrl + '" target="_blank" rel="noopener">Open page</a>' +
      '</div>' +
    '</div>';
}

function copyPayLink() {
  const input = document.getElementById('pay-link-out');
  input.select();
  navigator.clipboard.writeText(input.value).then(function () {
    // brief visual feedback
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = orig; }, 1500);
  }).catch(function () { document.execCommand('copy'); });
}

async function refreshPaymentLinks() {
  const container = document.getElementById('payment-links-list');
  if (!container) return;
  container.className = 'loading';
  container.textContent = 'Loading links...';
  if (!firebaseReady) {
    container.className = '';
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Firebase not connected</p></div>';
    return;
  }
  try {
    const snap = await fbOnce('/payment_links/');
    const data = snap.val() || {};
    const links = Object.entries(data)
      .map(([k, v]) => ({ _key: k, ...v }))
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 25);

    container.className = '';
    if (links.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">💳</div><p>No payment links yet</p></div>';
      return;
    }

    let html = '<table class="data-table"><thead><tr>' +
      '<th>For</th><th>Client Pays</th><th>Status</th><th>Views</th><th></th>' +
      '</tr></thead><tbody>';
    links.forEach(l => {
      const views = l.visits ? Object.keys(l.visits).length : 0;
      const live = l.presence ? Object.keys(l.presence).length : 0;
      const statusBadge = l.status === 'paid' ? 'badge-paid' : 'badge-unpaid';
      const payPageUrl = PAYMENTS_CONFIG.siteBase + '/pay/?id=' + l._key;
      html += '<tr>' +
        '<td>' + (l.description || '—') + (l.client_name ? '<br><small style="color:var(--text-dim);">' + l.client_name + '</small>' : '') + '</td>' +
        '<td style="color:var(--pink);font-weight:600;">' + formatCurrency(l.amount_total) + '</td>' +
        '<td><span class="badge ' + statusBadge + '">' + (l.status || 'active') + '</span>' +
          (live > 0 ? ' <span style="color:var(--green-light);">🟢 ' + live + ' live</span>' : '') + '</td>' +
        '<td>' + views + '</td>' +
        '<td><div class="btn-group">' +
          '<button class="btn btn-outline btn-sm" onclick="copyToClipboard(\'' + payPageUrl + '\')">Copy</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deletePaymentLink(\'' + l._key + '\')">Delete</button>' +
        '</div></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    container.className = '';
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>' + (err.message || err) + '</p></div>';
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(function () {});
}

async function deletePaymentLink(key) {
  if (!confirm('Delete this payment link record? (The Stripe link itself stays active in Stripe.)')) return;
  try {
    await fbRemove('/payment_links/' + key);
    refreshPaymentLinks();
  } catch (err) {
    alert('Failed to delete: ' + (err.message || err));
  }
}
