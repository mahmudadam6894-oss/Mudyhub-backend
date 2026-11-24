import crypto from 'crypto';

const MELE_BASE_URL = 'https://api.meledata.ng/api/v1/developer';
const ALLOWED_NETWORKS = new Set(['MTN', 'AIRTEL', 'GLO', '9MOBILE']);
const NETWORK_IDS = { MTN: 1, GLO: 2, '9MOBILE': 3, AIRTEL: 4 };
const now = () => Date.now();
const naira = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

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

function normalizeStatus(payload) {
  const value = String(payload?.data?.status || payload?.status || '').toLowerCase();
  if (payload?.status === true || ['success', 'successful', 'completed'].includes(value)) return 'success';
  if (['failed', 'failure', 'error', 'rejected'].includes(value) || payload?.success === false) return 'failed';
  return 'pending';
}

function safeError(payload, fallback) {
  return String(payload?.message || payload?.error || payload?.data?.message || fallback).slice(0, 240);
}

async function verifyWalletPin(db, uid, pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) throw new Error('Enter your 4-digit Wallet PIN.');
  const snap = await db.ref(`users/${uid}`).once('value');
  const user = snap.val();
  if (!user) throw new Error('User account was not found.');
  if (user.banned === true || user.status === 'banned' || user.walletFrozen === true) throw new Error('Your account or wallet is restricted.');
  if (!user.pinHash) throw new Error('Please set your Wallet PIN before making a purchase.');
  const entered = crypto.createHash('sha256').update(String(pin)).digest('hex');
  if (entered !== user.pinHash) throw new Error('Incorrect Wallet PIN.');
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
  if (!result.committed || !enough) throw new Error('Insufficient wallet balance.');
  return Number(result.snapshot.val());
}

async function refundOnce(db, uid, orderRef, reason) {
  const claim = await orderRef.child('refundStatus').transaction(current => {
    if (current === 'completed' || current === 'processing') return;
    return 'processing';
  });
  if (!claim.committed) return false;
  const orderSnap = await orderRef.once('value');
  const order = orderSnap.val();
  if (!order || !Number.isSafeInteger(Number(order.customerAmount))) return false;
  try {
    const wallet = await db.ref(`users/${uid}/walletBalance`).transaction(current => Number(current || 0) + Number(order.customerAmount));
    if (!wallet.committed) throw new Error('Wallet refund transaction did not commit.');
    const stamp = Date.now();
    await Promise.all([
      orderRef.update({ status: 'refunded', refundStatus: 'completed', refundReason: reason, refundedAt: stamp, updatedAt: stamp }),
      db.ref(`users/${uid}/transactions/${order.id}`).update({ status: 'refunded', updatedAt: stamp }),
      db.ref(`walletLedger/${uid}/${order.id}`).update({ status: 'refunded', updatedAt: stamp }),
      db.ref(`walletLedger/${uid}/${order.id}_refund`).set({ id: `${order.id}_refund`, type: 'purchase_refund', direction: 'credit', amount: order.customerAmount, reference: order.id, description: `Refund for ${order.description || 'VTU purchase'}`, status: 'completed', createdAt: stamp })
    ]);
    return true;
  } catch (error) {
    await orderRef.update({ refundStatus: 'error', refundError: String(error.message || error).slice(0, 200) });
    throw error;
  }
}

async function createOrder({ app, db, authenticatedUid, kind }) {
  app.post(`/api/data-airtime/${kind}/purchase`, async (req, res) => {
    let uid;
    let orderRef;
    let idempotencyRef;
    let debited = false;
    try {
      uid = await authenticatedUid(req);
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
      if (kind === 'data') {
        const planId = String(body.planId || '').trim();
        if (!/^\d{1,10}$/.test(planId)) return res.status(400).json({ ok: false, error: 'Select a valid data plan.' });
        const planSnap = await db.ref(`serviceCatalog/dataPlans/${planId}`).once('value');
        const plan = planSnap.val();
        if (!plan || plan.enabled !== true || String(plan.network || '').toUpperCase() !== network) return res.status(400).json({ ok: false, error: 'This data plan is unavailable. Refresh the plans and try again.' });
        if (!naira(plan.sellingPrice) || !/^\d{1,10}$/.test(String(plan.providerPlanId || ''))) return res.status(503).json({ ok: false, error: 'This plan is not fully configured yet. Please contact support.' });
        customerAmount = Number(plan.sellingPrice);
        providerPlanId = Number(plan.providerPlanId);
        description = `${network} ${String(plan.name || 'Data bundle').slice(0, 80)}`;
        providerBody = { network: NETWORK_IDS[network], phone, plan: providerPlanId, 'request-id': `MH_${crypto.randomUUID().replace(/-/g, '')}` };
      } else {
        const amount = Number(body.amount);
        if (!Number.isSafeInteger(amount) || amount < 50 || amount > 50000) return res.status(400).json({ ok: false, error: 'Airtime amount must be between ₦50 and ₦50,000.' });
        customerAmount = amount;
        description = `${network} airtime ₦${amount}`;
        providerBody = { network, phone, amount, reference: `MH_${crypto.randomUUID().replace(/-/g, '')}` };
      }

      idempotencyRef = db.ref(`dataAirtimeIdempotency/${uid}/${idempotencyKey}`);
      const claim = await idempotencyRef.transaction(current => current || { state: 'claimed', createdAt: now() });
      if (!claim.committed || claim.snapshot.val()?.orderId) {
        const existingId = claim.snapshot.val()?.orderId;
        if (existingId) {
          const existing = (await db.ref(`dataAirtimeOrders/${uid}/${existingId}`).once('value')).val();
          return res.status(200).json({ ok: true, duplicate: true, order: existing || { id: existingId, status: 'processing' } });
        }
        return res.status(409).json({ ok: false, error: 'This purchase request is already being processed. Check transaction history shortly.' });
      }

      const id = `vtu_${crypto.randomUUID().replace(/-/g, '')}`;
      orderRef = db.ref(`dataAirtimeOrders/${uid}/${id}`);
      const mode = String(process.env.MELE_MODE || 'test').toLowerCase();
      const order = {
        id, uid, kind, network, phone, description, customerAmount, providerPlanId,
        provider: 'MELE_DATA', providerReference: providerBody['request-id'] || providerBody.reference,
        mode, status: 'creating', refundStatus: 'not_required', idempotencyKey,
        createdAt: now(), updatedAt: now()
      };
      await orderRef.set(order);
      await idempotencyRef.update({ orderId: id, state: 'processing', updatedAt: now() });

      const balanceAfter = await reserveWallet(db, uid, customerAmount);
      debited = true;
      await Promise.all([
        orderRef.update({ status: 'processing', balanceAfter, debitedAt: now() }),
        db.ref(`users/${uid}/transactions/${id}`).set({ type: kind === 'data' ? 'data_purchase' : 'airtime_purchase', direction: 'debit', amount: customerAmount, reference: id, description, status: 'processing', provider: 'MELE_DATA', createdAt: now() }),
        db.ref(`walletLedger/${uid}/${id}`).set({ id, type: kind === 'data' ? 'data_purchase' : 'airtime_purchase', direction: 'debit', amount: customerAmount, reference: id, description, status: 'processing', createdAt: now() })
      ]);

      let providerResult;
      try {
        providerResult = await meleRequest(kind === 'data' ? '/data' : '/topup', { method: 'POST', body: providerBody });
      } catch (networkError) {
        await orderRef.update({ status: 'pending', providerMessage: 'Provider response not confirmed. Do not retry this order; check its status.', providerError: String(networkError.message || networkError).slice(0, 180), updatedAt: now() });
        await db.ref(`users/${uid}/transactions/${id}`).update({ status: 'pending' });
        await idempotencyRef.update({ state: 'pending' });
        return res.status(202).json({ ok: true, orderId: id, status: 'pending', message: 'Your purchase is being checked. Do not pay again; check transaction status.' });
      }

      const providerStatus = normalizeStatus(providerResult.payload);
      const providerRef = providerResult.payload?.data?.reference || providerResult.payload?.reference || order.providerReference;
      if (providerStatus === 'success') {
        await Promise.all([
          orderRef.update({ status: 'completed', providerReference: providerRef, providerResponse: providerResult.payload, completedAt: now(), updatedAt: now() }),
          db.ref(`users/${uid}/transactions/${id}`).update({ status: 'completed', providerReference: providerRef, completedAt: now() }),
          db.ref(`walletLedger/${uid}/${id}`).update({ status: 'completed', providerReference: providerRef })
        ]);
        await idempotencyRef.update({ state: 'completed' });
        return res.json({ ok: true, orderId: id, status: 'completed', message: 'Purchase completed successfully.' });
      }
      if ((providerStatus === 'failed' || (providerResult.response.status >= 400 && providerResult.response.status < 500)) && providerResult.response.status < 500) {
        await orderRef.update({ status: 'failed', providerReference: providerRef, providerMessage: safeError(providerResult.payload, 'Provider rejected the purchase.'), updatedAt: now() });
        await refundOnce(db, uid, orderRef, safeError(providerResult.payload, 'Provider rejected the purchase.'));
        await idempotencyRef.update({ state: 'refunded' });
        return res.status(200).json({ ok: true, orderId: id, status: 'refunded', message: 'The provider could not complete this purchase. Your wallet has been refunded.' });
      }

      await orderRef.update({ status: 'pending', providerReference: providerRef, providerMessage: safeError(providerResult.payload, 'Provider has not confirmed the transaction.'), providerHttpStatus: providerResult.response.status, updatedAt: now() });
      await db.ref(`users/${uid}/transactions/${id}`).update({ status: 'pending', providerReference: providerRef });
      await idempotencyRef.update({ state: 'pending' });
      return res.status(202).json({ ok: true, orderId: id, status: 'pending', message: 'The provider has not confirmed this purchase yet. Do not retry or pay again.' });
    } catch (error) {
      console.error(`[DATA-AIRTIME] ${kind} purchase error:`, error);
      if (debited && orderRef && uid) {
        try { await refundOnce(db, uid, orderRef, 'Internal processing error before a confirmed provider result.'); }
        catch (refundError) { console.error('[DATA-AIRTIME] Refund needs admin review:', refundError); }
      } else if (orderRef) {
        await orderRef.remove().catch(() => {});
        if (idempotencyRef) await idempotencyRef.remove().catch(() => {});
      }
      const status = error.message === 'Unauthorized' ? 401 : /PIN|wallet|account|restricted|Insufficient/i.test(error.message) ? 400 : 500;
      return res.status(status).json({ ok: false, error: error.message || 'Purchase could not be processed.' });
    }
  });
}

export default function registerDataAirtime({ app, db, authenticatedUid }) {
  // Public-to-authenticated-user catalogue. The provider's docs publish plan IDs,
  // but do not document a machine-readable catalogue endpoint. MudyHub therefore
  // serves only plans explicitly loaded and enabled in its own Firebase catalogue.
  app.get('/api/data-airtime/plans', async (req, res) => {
    try {
      await authenticatedUid(req);
      const network = String(req.query.network || '').trim().toUpperCase();
      const snap = await db.ref('serviceCatalog/dataPlans').once('value');
      const raw = snap.val() || {};
      const plans = Object.entries(raw)
        .filter(([, p]) => p && p.enabled === true && (!network || p.network === network))
        .map(([id, p]) => ({ id, network: p.network, name: p.name, validity: p.validity || null, type: p.type || null, price: Number(p.sellingPrice), currency: 'NGN' }))
        .filter(p => ALLOWED_NETWORKS.has(String(p.network || '').toUpperCase()) && Number.isSafeInteger(p.price) && p.price > 0);
      return res.json({ ok: true, provider: 'MELE_DATA', mode: String(process.env.MELE_MODE || 'test'), plans });
    } catch (error) {
      return res.status(error.message === 'Unauthorized' ? 401 : 500).json({ ok: false, error: error.message || 'Could not load data plans.' });
    }
  });

  app.get('/api/data-airtime/provider/balance', async (req, res) => {
    try {
      await authenticatedUid(req);
      const result = await meleRequest('/user');
      if (!result.response.ok) return res.status(502).json({ ok: false, error: safeError(result.payload, 'Could not read provider balance.') });
      const balance = result.payload?.data?.balance ?? result.payload?.user?.wallet_balance;
      return res.json({ ok: true, mode: result.mode, balance: Number.isFinite(Number(balance)) ? Number(balance) : null, currency: result.payload?.data?.currency || 'NGN' });
    } catch (error) {
      return res.status(error.message === 'Unauthorized' ? 401 : 503).json({ ok: false, error: error.message || 'Provider balance is unavailable.' });
    }
  });

  createOrder({ app, db, authenticatedUid, kind: 'data' });
  createOrder({ app, db, authenticatedUid, kind: 'airtime' });

  app.get('/api/data-airtime/transactions/:orderId', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const orderRef = db.ref(`dataAirtimeOrders/${uid}/${String(req.params.orderId || '')}`);
      const snap = await orderRef.once('value');
      const order = snap.val();
      if (!order) return res.status(404).json({ ok: false, error: 'Transaction not found.' });
      if (order.status === 'pending' && order.providerReference) {
        try {
          const result = await meleRequest(`/data/status?ref=${encodeURIComponent(order.providerReference)}`);
          const status = normalizeStatus(result.payload);
          if (status === 'success') {
            await Promise.all([
              orderRef.update({ status: 'completed', providerResponse: result.payload, completedAt: now(), updatedAt: now() }),
              db.ref(`users/${uid}/transactions/${order.id}`).update({ status: 'completed', completedAt: now() }),
              db.ref(`walletLedger/${uid}/${order.id}`).update({ status: 'completed' }),
              db.ref(`dataAirtimeIdempotency/${uid}/${order.idempotencyKey}`).update({ state: 'completed' })
            ]);
            order.status = 'completed';
          } else if (status === 'failed') {
            await orderRef.update({ status: 'failed', updatedAt: now(), providerResponse: result.payload });
            await refundOnce(db, uid, orderRef, safeError(result.payload, 'Provider confirmed the transaction failed.'));
            await db.ref(`dataAirtimeIdempotency/${uid}/${order.idempotencyKey}`).update({ state: 'refunded' });
            order.status = 'refunded';
          }
        } catch (statusError) {
          console.error('[DATA-AIRTIME] Status query failed:', statusError.message);
        }
      }
      return res.json({ ok: true, order: { id: order.id, kind: order.kind, network: order.network, phone: order.phone, description: order.description, amount: order.customerAmount, status: order.status, provider: order.provider, createdAt: order.createdAt, updatedAt: order.updatedAt } });
    } catch (error) {
      return res.status(error.message === 'Unauthorized' ? 401 : 500).json({ ok: false, error: error.message || 'Could not check transaction.' });
    }
  });
}
