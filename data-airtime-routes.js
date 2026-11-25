import crypto from 'crypto';

const MELE_BASE_URL = 'https://api.meledata.ng/api/v1/developer';
const ALLOWED_NETWORKS = new Set(['MTN', 'AIRTEL', 'GLO', '9MOBILE']);
const NETWORK_IDS = { MTN: 1, GLO: 2, '9MOBILE': 3, AIRTEL: 4 };
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const ORDER_ID_PATTERN = /^vtu_[a-f0-9]{32}$/;

const now = () => Date.now();
const isNaira = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function providerKey() {
  const mode = String(process.env.MELE_MODE || 'test').toLowerCase();
  if (mode !== 'test' && mode !== 'live') throw new Error('MELE_MODE must be test or live.');
  const key = mode === 'test'
    ? String(process.env.MELE_TEST_API_KEY || '').trim()
    : String(process.env.MELE_LIVE_API_KEY || '').trim();
  if (!key) throw new Error(`MELE ${mode.toUpperCase()} API key is not configured.`);
  if (mode === 'test' && !key.startsWith('mele_test_')) throw new Error('The MELE test key format is invalid.');
  if (mode === 'live' && !key.startsWith('mele_live_')) throw new Error('The MELE live key format is invalid.');
  return { mode, key };
}

async function meleRequest(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const { mode, key } = providerKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MELE_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 500) }; }
    return { response, payload, mode };
  } finally {
    clearTimeout(timer);
  }
}

// FIX: the nested provider status is checked FIRST. A reply such as
// { status: true, data: { status: 'pending' } } is now correctly treated as pending, not success.
function normalizeStatus(payload) {
  const nested = payload?.data?.status;
  const raw = nested !== undefined && nested !== null ? nested : payload?.status;
  if (raw === true) return nested === undefined || nested === null ? 'success' : 'pending';
  const value = String(raw ?? '').toLowerCase();
  if (['success', 'successful', 'completed', 'delivered'].includes(value)) return 'success';
  if (['failed', 'failure', 'error', 'rejected', 'reversed'].includes(value)) return 'failed';
  if (payload?.success === false) return 'failed';
  return 'pending';
}

function safeError(payload, fallback) {
  return String(payload?.message || payload?.error || payload?.data?.message || fallback).slice(0, 240);
}

// Provider replies are saved as short text, never as raw objects: Firebase rejects keys that contain
// characters such as "." or "$", and a rejected write after a delivered purchase must never happen.
function snapshotPayload(payload) {
  try { return JSON.stringify(payload).slice(0, 2000); } catch (_) { return ''; }
}

// Only fields that are safe to show the customer. Provider details stay on the server.
function publicOrder(order) {
  return {
    id: order.id,
    kind: order.kind,
    network: order.network,
    phone: order.phone,
    description: order.description,
    amount: order.customerAmount,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

// FIX: wrong-PIN attempts are counted and the wallet PIN locks for 15 minutes after 5 failures.
async function verifyWalletPin(db, uid, pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) throw fail(400, 'Enter your 4-digit Wallet PIN.');
  const snap = await db.ref(`users/${uid}`).once('value');
  const user = snap.val();
  if (!user) throw fail(404, 'User account was not found.');
  if (user.banned === true || user.status === 'banned' || user.walletFrozen === true) throw fail(403, 'Your account or wallet is restricted.');
  if (!user.pinHash) throw fail(400, 'Please set your Wallet PIN before making a purchase.');

  const attemptsRef = db.ref(`walletPinAttempts/${uid}`);
  const attempts = (await attemptsRef.once('value')).val() || {};
  if (Number(attempts.lockedUntil || 0) > now()) {
    const mins = Math.ceil((Number(attempts.lockedUntil) - now()) / 60000);
    throw fail(429, `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }

  if (!safeEqual(sha256(pin), user.pinHash)) {
    await attemptsRef.transaction(current => {
      const c = current || {};
      const lockExpired = Number(c.lockedUntil || 0) > 0 && Number(c.lockedUntil) <= now();
      const count = (lockExpired ? 0 : Number(c.count || 0)) + 1;
      if (count >= MAX_PIN_ATTEMPTS) return { count: 0, lockedUntil: now() + PIN_LOCK_MS, updatedAt: now() };
      return { count, lockedUntil: 0, updatedAt: now() };
    });
    throw fail(401, 'Incorrect Wallet PIN.');
  }
  if (attempts.count || attempts.lockedUntil) await attemptsRef.remove().catch(() => {});
  return user;
}

async function reserveWallet(db, uid, amount) {
  const walletRef = db.ref(`users/${uid}/walletBalance`);
  let enough = false;
  const result = await walletRef.transaction(current => {
    enough = false;
    if (current === null) return 0;
    const balance = Number(current);
    if (!Number.isFinite(balance) || balance < amount) return;
    enough = true;
    return balance - amount;
  });
  if (!result.committed || !enough) throw fail(400, 'Insufficient wallet balance.');
  return Number(result.snapshot.val());
}

// FIX: once the wallet has been credited, the order is marked refunded IMMEDIATELY, so later
// bookkeeping errors can never allow a second credit. Retry is only possible if the credit itself failed.
async function refundOnce(db, uid, orderRef, reason) {
  const claim = await orderRef.child('refundStatus').transaction(current => {
    if (current === 'completed' || current === 'processing') return;
    return 'processing';
  });
  if (!claim.committed) return false;

  const order = (await orderRef.once('value')).val();
  if (!order || !isNaira(order.customerAmount)) {
    await orderRef.update({ refundStatus: 'error', refundError: 'Order amount is invalid.' }).catch(() => {});
    return false;
  }

  try {
    const wallet = await db.ref(`users/${uid}/walletBalance`).transaction(current => Number(current || 0) + Number(order.customerAmount));
    if (!wallet.committed) throw new Error('Wallet refund transaction did not commit.');
  } catch (error) {
    // The wallet was NOT credited, so allowing a retry is safe here.
    await orderRef.update({ refundStatus: 'error', refundError: String(error.message || error).slice(0, 200) }).catch(() => {});
    throw error;
  }

  const stamp = now();
  try {
    await orderRef.update({ status: 'refunded', refundStatus: 'completed', refundReason: String(reason || '').slice(0, 240), refundedAt: stamp, updatedAt: stamp });
  } catch (error) {
    // Wallet is already credited. refundStatus stays 'processing', which blocks any second credit.
    console.error('[DATA-AIRTIME] Refund credited but order not updated (needs admin check):', order.id, error.message);
  }
  await Promise.allSettled([
    db.ref(`users/${uid}/transactions/${order.id}`).update({ status: 'refunded', updatedAt: stamp }),
    db.ref(`walletLedger/${uid}/${order.id}`).update({ status: 'refunded', updatedAt: stamp }),
    db.ref(`walletLedger/${uid}/${order.id}_refund`).set({ id: `${order.id}_refund`, type: 'purchase_refund', direction: 'credit', amount: order.customerAmount, reference: order.id, description: `Refund for ${order.description || 'VTU purchase'}`, status: 'completed', createdAt: stamp })
  ]);
  return true;
}

function registerPurchaseRoute({ app, db, authenticatedUid, kind }) {
  app.post(`/api/data-airtime/${kind}/purchase`, async (req, res) => {
    let uid;
    let orderRef;
    let idempotencyRef;
    let ownsClaim = false;
    let debited = false;
    let providerCalled = false;
    try {
      uid = await authenticatedUid(req);

      // Admin "pause wallet operations" switch also pauses purchases.
      try {
        const settings = (await db.ref('platformSettings').once('value')).val() || {};
        if (settings.walletOpsPaused === true) return res.status(503).json({ ok: false, error: 'Purchases are paused for a short while. Please try again later.' });
      } catch (_) { /* never block users because the settings read failed */ }

      const body = req.body || {};
      const phone = String(body.phone || '').replace(/\s+/g, '');
      const network = String(body.network || '').trim().toUpperCase();
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      if (!/^0\d{10}$/.test(phone)) return res.status(400).json({ ok: false, error: 'Enter a valid 11-digit Nigerian phone number.' });
      if (!ALLOWED_NETWORKS.has(network)) return res.status(400).json({ ok: false, error: 'Select a supported network.' });
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) return res.status(400).json({ ok: false, error: 'A valid idempotencyKey (8–100 characters) is required.' });
      await verifyWalletPin(db, uid, body.pin);

      let providerBody;
      let customerAmount;
      let description;
      let providerPlanId = null;
      let providerCost = null;
      const providerRequestId = `MH_${crypto.randomUUID().replace(/-/g, '')}`;

      if (kind === 'data') {
        const planId = String(body.planId || '').trim();
        if (!/^\d{1,10}$/.test(planId)) return res.status(400).json({ ok: false, error: 'Select a valid data plan.' });
        const plan = (await db.ref(`serviceCatalog/dataPlans/${planId}`).once('value')).val();
        if (!isNaira(plan.sellingPrice) || !/^\d{1,10}$/.test(String(plan.providerPlanId || ''))) return res.status(503).json({ ok: false, error: 'This plan is not fully configured yet. Please contact support.' });
        if (
  !plan ||
  plan.enabled !== true ||
  plan.verified !== true ||
  String(plan.network || '').toUpperCase() !== network
) {
  return res.status(400).json({
    ok: false,
    error: 'This data plan is unavailable. Refresh the plans and try again.'
  });
                                                               }
        const cost = Number(plan.providerCost);
        // Safety: never sell a plan below its own cost price.
        if (Number.isFinite(cost) && cost > 0 && Number(plan.sellingPrice) < cost) return res.status(503).json({ ok: false, error: 'This plan is temporarily unavailable. Please contact support.' });
        providerCost = Number.isFinite(cost) && cost > 0 ? cost : null;
        customerAmount = Number(plan.sellingPrice);
        providerPlanId = Number(plan.providerPlanId);
        description = `${network} ${String(plan.name || 'Data bundle').slice(0, 80)}`;
        providerBody = { network: NETWORK_IDS[network], phone, plan: providerPlanId, 'request-id': providerRequestId };
      } else {
        const amount = Number(body.amount);
        if (!Number.isSafeInteger(amount) || amount < 50 || amount > 50000) return res.status(400).json({ ok: false, error: 'Airtime amount must be between ₦50 and ₦50,000.' });
        customerAmount = amount;
        // Optional profit tracking: set AIRTIME_DISCOUNT_PERCENT in Render to MELE's airtime discount (for example 2).
        const discount = Number(process.env.AIRTIME_DISCOUNT_PERCENT);
        if (process.env.AIRTIME_DISCOUNT_PERCENT && Number.isFinite(discount) && discount >= 0 && discount < 50) {
          providerCost = Math.round(amount * (1 - discount / 100) * 100) / 100;
        }
        description = `${network} airtime ₦${amount}`;
        // Verify this body format against MELE's airtime documentation before going live.
        providerBody = { network, phone, amount, reference: providerRequestId };
      }

      // FIX: only the request that CREATED the claim may continue. Any other request
      // with the same key is answered from the existing order and never buys again.
      idempotencyRef = db.ref(`dataAirtimeIdempotency/${uid}/${idempotencyKey}`);
      let createdClaim = false;
      const claim = await idempotencyRef.transaction(current => {
        createdClaim = false;
        if (current) return;
        createdClaim = true;
        return { state: 'claimed', createdAt: now() };
      });
      ownsClaim = claim.committed && createdClaim;
      if (!ownsClaim) {
        const existingClaim = claim.snapshot.val() || {};
        if (existingClaim.orderId) {
          const existing = (await db.ref(`dataAirtimeOrders/${uid}/${existingClaim.orderId}`).once('value')).val();
          if (existing) return res.status(200).json({ ok: true, duplicate: true, orderId: existing.id, status: existing.status, message: 'This purchase was already submitted. Showing its current status.' });
        }
        return res.status(409).json({ ok: false, error: 'This purchase request is already being processed. Check Recent transactions shortly.' });
      }

      const id = `vtu_${crypto.randomUUID().replace(/-/g, '')}`;
      orderRef = db.ref(`dataAirtimeOrders/${uid}/${id}`);
      const mode = String(process.env.MELE_MODE || 'test').toLowerCase();
      const order = {
        id, uid, kind, network, phone, description, customerAmount, providerPlanId,
        providerCost, profit: providerCost !== null ? customerAmount - providerCost : null,
        provider: 'MELE_DATA', providerReference: providerRequestId,
        mode, status: 'creating', refundStatus: 'not_required', idempotencyKey,
        createdAt: now(), updatedAt: now()
      };
      await orderRef.set(order);
      await idempotencyRef.update({ orderId: id, state: 'processing', updatedAt: now() });

      const balanceAfter = await reserveWallet(db, uid, customerAmount);
      debited = true;
      await Promise.all([
        orderRef.update({ status: 'processing', balanceAfter, debitedAt: now() }),
        db.ref(`users/${uid}/transactions/${id}`).set({ type: kind === 'data' ? 'data_purchase' : 'airtime_purchase', direction: 'debit', amount: customerAmount, reference: id, description, status: 'processing', createdAt: now() }),
        db.ref(`walletLedger/${uid}/${id}`).set({ id, type: kind === 'data' ? 'data_purchase' : 'airtime_purchase', direction: 'debit', amount: customerAmount, reference: id, description, status: 'processing', createdAt: now() })
      ]);

      // From this line on the provider may deliver, so NO automatic refund is allowed unless the provider clearly failed.
      providerCalled = true;
      let providerResult;
      try {
        providerResult = await meleRequest(kind === 'data' ? '/data' : '/topup', { method: 'POST', body: providerBody });
      } catch (networkError) {
        await orderRef.update({ status: 'pending', providerMessage: 'Provider response not confirmed. Do not retry this order; check its status.', providerError: String(networkError.message || networkError).slice(0, 180), updatedAt: now() });
        await Promise.allSettled([
          db.ref(`users/${uid}/transactions/${id}`).update({ status: 'pending' }),
          idempotencyRef.update({ state: 'pending' })
        ]);
        return res.status(202).json({ ok: true, orderId: id, status: 'pending', message: 'Your purchase is being checked. Do not pay again; check its status in Recent transactions.' });
      }

      const httpStatus = providerResult.response.status;
      const providerStatus = normalizeStatus(providerResult.payload);
      const providerRef = providerResult.payload?.data?.reference || providerResult.payload?.reference || order.providerReference;

      if (providerStatus === 'success' && providerResult.response.ok) {
        await orderRef.update({ status: 'completed', providerReference: providerRef, providerResponse: snapshotPayload(providerResult.payload), completedAt: now(), updatedAt: now() });
        await Promise.allSettled([
          db.ref(`users/${uid}/transactions/${id}`).update({ status: 'completed', providerReference: providerRef, completedAt: now() }),
          db.ref(`walletLedger/${uid}/${id}`).update({ status: 'completed', providerReference: providerRef }),
          idempotencyRef.update({ state: 'completed' })
        ]);
        return res.json({ ok: true, orderId: id, status: 'completed', message: 'Purchase completed successfully.' });
      }

      // A clear failure: the provider said "failed", or rejected the request (4xx). 408 (timeout) stays pending.
      const clearlyFailed = httpStatus < 500 && (providerStatus === 'failed' || (httpStatus >= 400 && httpStatus !== 408));
      if (clearlyFailed) {
        const message = safeError(providerResult.payload, 'Provider rejected the purchase.');
        await orderRef.update({ status: 'failed', providerReference: providerRef, providerMessage: message, providerHttpStatus: httpStatus, providerResponse: snapshotPayload(providerResult.payload), updatedAt: now() });
        const refunded = await refundOnce(db, uid, orderRef, message);
        await idempotencyRef.update({ state: refunded ? 'refunded' : 'failed' }).catch(() => {});
        return res.status(200).json({ ok: true, orderId: id, status: refunded ? 'refunded' : 'pending', message: refunded ? 'The provider could not complete this purchase. Your wallet has been refunded.' : 'The purchase could not be completed. Your refund is being processed.' });
      }

      await orderRef.update({ status: 'pending', providerReference: providerRef, providerMessage: safeError(providerResult.payload, 'Provider has not confirmed the transaction.'), providerHttpStatus: httpStatus, providerResponse: snapshotPayload(providerResult.payload), updatedAt: now() });
      await Promise.allSettled([
        db.ref(`users/${uid}/transactions/${id}`).update({ status: 'pending', providerReference: providerRef }),
        idempotencyRef.update({ state: 'pending' })
      ]);
      return res.status(202).json({ ok: true, orderId: id, status: 'pending', message: 'The provider has not confirmed this purchase yet. Do not retry or pay again.' });
    } catch (error) {
      console.error(`[DATA-AIRTIME] ${kind} purchase error:`, error);

      // FIX: if the provider was already called, it may have delivered. Never refund automatically here.
      if (orderRef && providerCalled) {
        await orderRef.update({ status: 'pending', providerMessage: 'Result could not be recorded. Needs a status check.', updatedAt: now() }).catch(() => {});
        return res.status(202).json({ ok: true, orderId: orderRef.key, status: 'pending', message: 'Your purchase is being checked. Do not pay again; check its status in Recent transactions.' });
      }

      let refunded = false;
      if (debited && orderRef && uid) {
        try { refunded = await refundOnce(db, uid, orderRef, 'Internal processing error before the provider was contacted.'); }
        catch (refundError) { console.error('[DATA-AIRTIME] Refund needs admin review:', refundError); }
        if (idempotencyRef && ownsClaim) await idempotencyRef.update({ state: refunded ? 'refunded' : 'failed' }).catch(() => {});
      } else {
        if (orderRef) await orderRef.remove().catch(() => {});
        if (idempotencyRef && ownsClaim) await idempotencyRef.remove().catch(() => {});
      }
      const status = error.status || (error.message === 'Unauthorized' ? 401 : 500);
      const suffix = debited ? (refunded ? ' Your wallet has been refunded.' : ' If your wallet was charged, contact support with your order reference.') : '';
      return res.status(status).json({ ok: false, error: (error.message || 'Purchase could not be processed.') + suffix });
    }
  });
}

export default function registerDataAirtime({ app, db, authenticatedUid, requireAdmin }) {
  // Customer-facing plan list. Only plans loaded AND enabled in MudyHub's own catalogue are shown.
  app.get('/api/data-airtime/plans', async (req, res) => {
    try {
      await authenticatedUid(req);
      const network = String(req.query.network || '').trim().toUpperCase();
      const snap = await db.ref('serviceCatalog/dataPlans').once('value');
      const raw = snap.val() || {};
      const plans = Object.entries(raw)
        .map(([id, p]) => ({ id, network: String(p.network || '').toUpperCase(), name: p.name, validity: p.validity || null, type: p.type || null, price: Number(p.sellingPrice), cost: Number(p.providerCost), providerPlanId: String(p.providerPlanId || '') }))
        .filter(([, p]) =>
  p &&
  p.enabled === true &&
  p.verified === true &&
  (!network || String(p.network || '').toUpperCase() === network)
)
        .filter(p => ALLOWED_NETWORKS.has(p.network) && Number.isSafeInteger(p.price) && p.price > 0 && /^\d{1,10}$/.test(p.providerPlanId))
        .filter(p => !(Number.isFinite(p.cost) && p.cost > 0 && p.price < p.cost))
        .map(p => ({ id: p.id, network: p.network, name: p.name, validity: p.validity, type: p.type, price: p.price, currency: 'NGN' }));
      return res.json({ ok: true, plans });
    } catch (error) {
      return res.status(error.message === 'Unauthorized' ? 401 : 500).json({ ok: false, error: error.message || 'Could not load data plans.' });
    }
  });

  // FIX: the provider wallet balance is business information, so it is now Super Admin only.
  app.get('/api/data-airtime/provider/balance', async (req, res) => {
    try {
      if (typeof requireAdmin !== 'function') return res.status(403).json({ ok: false, error: 'You do not have permission for this action.' });
      const actor = await requireAdmin(req);
      if (actor.role !== 'super_admin') throw new Error('Forbidden');
      const result = await meleRequest('/user');
      if (!result.response.ok) return res.status(502).json({ ok: false, error: safeError(result.payload, 'Could not read provider balance.') });
      const balance = result.payload?.data?.balance ?? result.payload?.user?.wallet_balance;
      return res.json({ ok: true, mode: result.mode, balance: Number.isFinite(Number(balance)) ? Number(balance) : null, currency: result.payload?.data?.currency || 'NGN' });
    } catch (error) {
      const status = error.message === 'Unauthorized' ? 401 : error.message === 'Forbidden' ? 403 : 503;
      return res.status(status).json({ ok: false, error: status === 403 ? 'You do not have permission for this action.' : (error.message || 'Provider balance is unavailable.') });
    }
  });

  registerPurchaseRoute({ app, db, authenticatedUid, kind: 'data' });
  registerPurchaseRoute({ app, db, authenticatedUid, kind: 'airtime' });

  // NEW: the customer's last 20 purchases (powers the Recent transactions panel).
  // Optional but recommended: add ".indexOn": ["createdAt"] under dataAirtimeOrders/$uid in your Firebase rules.
  app.get('/api/data-airtime/transactions', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const snap = await db.ref(`dataAirtimeOrders/${uid}`).orderByChild('createdAt').limitToLast(20).once('value');
      const orders = [];
      snap.forEach(child => { const o = child.val(); if (o && o.id) orders.push(publicOrder(o)); });
      orders.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      return res.json({ ok: true, orders });
    } catch (error) {
      return res.status(error.message === 'Unauthorized' ? 401 : 500).json({ ok: false, error: error.message || 'Could not load transactions.' });
    }
  });

  app.get('/api/data-airtime/transactions/:orderId', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const orderId = String(req.params.orderId || '');
      if (!ORDER_ID_PATTERN.test(orderId)) return res.status(400).json({ ok: false, error: 'That order ID is not valid.' });
      const orderRef = db.ref(`dataAirtimeOrders/${uid}/${orderId}`);
      const order = (await orderRef.once('value')).val();
      if (!order) return res.status(404).json({ ok: false, error: 'Transaction not found.' });

      if (order.status === 'pending' && order.providerReference) {
        // Data has a documented status endpoint. For airtime, set MELE_AIRTIME_STATUS_PATH in Render
        // (for example "/topup/status?ref=") once you have confirmed it in MELE's docs. Until then airtime
        // orders stay pending for manual review instead of guessing.
        const ref = encodeURIComponent(order.providerReference);
        const statusPath = order.kind === 'data'
          ? `/data/status?ref=${ref}`
          : (process.env.MELE_AIRTIME_STATUS_PATH ? `${String(process.env.MELE_AIRTIME_STATUS_PATH).trim()}${ref}` : null);
        if (statusPath) {
          try {
            const result = await meleRequest(statusPath);
            // Only trust the answer when the provider replied normally (not an auth or server error).
            if (result.response.ok) {
              const status = normalizeStatus(result.payload);
              if (status === 'success') {
                await orderRef.update({ status: 'completed', providerResponse: snapshotPayload(result.payload), completedAt: now(), updatedAt: now() });
                await Promise.allSettled([
                  db.ref(`users/${uid}/transactions/${order.id}`).update({ status: 'completed', completedAt: now() }),
                  db.ref(`walletLedger/${uid}/${order.id}`).update({ status: 'completed' }),
                  db.ref(`dataAirtimeIdempotency/${uid}/${order.idempotencyKey}`).update({ state: 'completed' })
                ]);
                order.status = 'completed';
              } else if (status === 'failed') {
                const message = safeError(result.payload, 'Provider confirmed the transaction failed.');
                await orderRef.update({ status: 'failed', updatedAt: now(), providerResponse: snapshotPayload(result.payload) });
                const refunded = await refundOnce(db, uid, orderRef, message);
                await db.ref(`dataAirtimeIdempotency/${uid}/${order.idempotencyKey}`).update({ state: refunded ? 'refunded' : 'failed' }).catch(() => {});
                order.status = refunded ? 'refunded' : 'pending';
              }
            }
          } catch (statusError) {
            console.error('[DATA-AIRTIME] Status query failed:', statusError.message);
          }
        }
      }
      return res.json({ ok: true, order: publicOrder(order) });
    } catch (error) {
      return res.status(error.message === 'Unauthorized' ? 401 : 500).json({ ok: false, error: error.message || 'Could not check transaction.' });
    }
  });
}
