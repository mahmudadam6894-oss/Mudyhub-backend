// ============================================================================
// airtime-cash-routes.js
// MudyHub Airtime to Cash — isolated backend routes.
// Uses users/{uid}/walletBalance as the canonical wallet balance.
// ============================================================================

import crypto from 'crypto';

const ALLOWED_NETWORKS = new Set(['MTN', 'AIRTEL', 'GLO', '9MOBILE']);
const now = () => Date.now();
const fail = (status, message) => Object.assign(new Error(message), { status });

function cleanText(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeConfig(raw = {}) {
  const networks = Array.isArray(raw.networks) ? raw.networks : [];
  return {
    enabled: raw.enabled === true,
    minAmount: Number.isSafeInteger(Number(raw.minAmount)) ? Number(raw.minAmount) : 500,
    maxAmount: Number.isSafeInteger(Number(raw.maxAmount)) ? Number(raw.maxAmount) : 50000,
    payoutPercent: Number.isFinite(Number(raw.payoutPercent)) ? Number(raw.payoutPercent) : 90,
    networks: networks
      .filter(n => n && ALLOWED_NETWORKS.has(String(n.network || '').toUpperCase()))
      .map(n => ({
        network: String(n.network).toUpperCase(),
        number: cleanText(n.number, 30),
        enabled: n.enabled === true
      }))
      .filter(n => n.enabled && n.number)
  };
}

function publicRequest(r) {
  return {
    id: r.id,
    network: r.network,
    amount: r.amount,
    payout: r.payout,
    senderPhone: r.senderPhone,
    reference: r.reference || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status,
    rejectReason: r.rejectReason || ''
  };
}

async function getSuperAdmin(requireAdmin, req) {
  if (typeof requireAdmin !== 'function') throw fail(403, 'Admin authorization is unavailable.');
  const actor = await requireAdmin(req);
  if (actor.role !== 'super_admin') throw fail(403, 'Super Admin access required.');
  return actor;
}

function sendError(res, error, fallback) {
  const status = Number(error?.status) || (
    error?.message === 'Unauthorized' ? 401 :
    error?.message === 'Forbidden' ? 403 : 500
  );
  return res.status(status).json({
    ok: false,
    error: status === 403 ? 'You do not have permission for this action.' :
      (error?.message || fallback || 'The request could not be processed.')
  });
}

export function registerAirtimeCash({
  app, admin, db, authenticatedUid, requireAdmin, writeAudit
}) {
  if (!app || !db || typeof authenticatedUid !== 'function') {
    throw new Error('Airtime Cash route dependencies are missing.');
  }

  const configRef = db.ref('serviceConfig/airtimeCash');

  // --------------------------------------------------------------------------
  // CUSTOMER: wallet balance. Same source used by the rest of MudyHub.
  // --------------------------------------------------------------------------
  app.get('/api/data-airtime/wallet', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const snap = await db.ref(`users/${uid}/walletBalance`).once('value');
      const balance = Number(snap.val() || 0);
      if (!Number.isFinite(balance) || balance < 0) {
        return res.status(503).json({ ok: false, error: 'Your wallet balance is temporarily unavailable.' });
      }
      return res.json({ ok: true, balance, walletBalance: balance, available: balance });
    } catch (error) {
      return sendError(res, error, 'Could not load wallet balance.');
    }
  });

  // --------------------------------------------------------------------------
  // CUSTOMER: public conversion configuration. Receiver numbers must be set
  // by a Super Admin; this route never invents or exposes disabled numbers.
  // --------------------------------------------------------------------------
  app.get('/api/airtime-cash/config', async (req, res) => {
    try {
      await authenticatedUid(req);
      const raw = (await configRef.once('value')).val() || {};
      const cfg = normalizeConfig(raw);
      const validLimits = cfg.minAmount > 0 &&
        cfg.maxAmount >= cfg.minAmount &&
        cfg.payoutPercent > 0 && cfg.payoutPercent <= 100;

      return res.json({
        ok: true,
        enabled: raw.enabled === true && validLimits && cfg.networks.length > 0,
        minAmount: cfg.minAmount,
        maxAmount: cfg.maxAmount,
        payoutPercent: cfg.payoutPercent,
        networks: cfg.networks.map(n => ({ network: n.network, number: n.number }))
      });
    } catch (error) {
      return sendError(res, error, 'Could not load Airtime to Cash settings.');
    }
  });

  // --------------------------------------------------------------------------
  // CUSTOMER: submit request. No wallet credit occurs here.
  // --------------------------------------------------------------------------
  app.post('/api/airtime-cash/request', async (req, res) => {
    let uid;
    let idempotencyRef;
    let ownsClaim = false;

    try {
      uid = await authenticatedUid(req);
      const user = (await db.ref(`users/${uid}`).once('value')).val();
      if (!user || user.banned === true || user.status === 'banned') {
        throw fail(403, 'Your account is not permitted to use Airtime to Cash.');
      }

      const body = req.body || {};
      const network = cleanText(body.network, 20).toUpperCase();
      const senderPhone = cleanText(body.senderPhone, 20).replace(/\s+/g, '');
      const amount = Number(body.amount);
      const reference = cleanText(body.reference, 80);
      const idempotencyKey = cleanText(body.idempotencyKey, 100);

      if (!ALLOWED_NETWORKS.has(network)) throw fail(400, 'Select a supported network.');
      if (!/^0\d{10}$/.test(senderPhone)) throw fail(400, 'Enter a valid 11-digit Nigerian sender phone number.');
      if (!Number.isSafeInteger(amount) || amount <= 0) throw fail(400, 'Enter a valid airtime amount.');
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw fail(400, 'A valid request key is required.');
      if (reference.length > 80) throw fail(400, 'The transfer reference is too long.');

      const rawConfig = (await configRef.once('value')).val() || {};
      const cfg = normalizeConfig(rawConfig);
      const networkConfig = cfg.networks.find(n => n.network === network);
      if (rawConfig.enabled !== true || !networkConfig) {
        throw fail(503, 'Airtime to Cash is not available for this network right now.');
      }
      if (amount < cfg.minAmount || amount > cfg.maxAmount) {
        throw fail(400, `Amount must be between ₦${cfg.minAmount.toLocaleString('en-NG')} and ₦${cfg.maxAmount.toLocaleString('en-NG')}.`);
      }
      if (!(cfg.payoutPercent > 0 && cfg.payoutPercent <= 100)) {
        throw fail(503, 'Airtime to Cash payout settings are not configured correctly.');
      }

      idempotencyRef = db.ref(`airtimeCashIdempotency/${uid}/${idempotencyKey}`);
      let created = false;
      const claim = await idempotencyRef.transaction(current => {
        created = false;
        if (current) return;
        created = true;
        return { state: 'claimed', createdAt: now() };
      });

      if (!claim.committed || !created) {
        const existing = claim.snapshot.val() || {};
        if (existing.requestId) {
          const old = (await db.ref(`airtimeCashRequests/${uid}/${existing.requestId}`).once('value')).val();
          if (old) {
            return res.status(200).json({
              ok: true, duplicate: true, request: publicRequest(old),
              message: 'This request was already submitted. Here is its current status.'
            });
          }
        }
        throw fail(409, 'A similar request is already being processed. Please check My Requests.');
      }

      ownsClaim = true;

      const id = `ac_${crypto.randomBytes(16).toString('hex')}`;
      const payout = Math.floor(amount * cfg.payoutPercent / 100);
      const timestamp = now();
            const request = {
        id,
        uid,
        network,
        senderPhone,
        amount,
        payout,
        payoutPercent: cfg.payoutPercent,
        receiverNumber: networkConfig.number,
        reference,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp
      };

      await db.ref(`airtimeCashRequests/${uid}/${id}`).set(request);

      await idempotencyRef.update({
        state: 'submitted',
        requestId: id,
        updatedAt: now()
      });

      ownsClaim = false;

      return res.status(201).json({
        ok: true,
        request: publicRequest(request),
        message: 'Your request was submitted. Your wallet will be credited after the airtime is verified.'
      });

    } catch (error) {
      if (ownsClaim && idempotencyRef) {
        try {
          await idempotencyRef.remove();
        } catch (_) {}
      }
      return sendError(res, error, 'Could not submit your Airtime to Cash request.');
    }
  });

  // --------------------------------------------------------------------------
  // CUSTOMER: list only the signed-in user's own requests.
  // --------------------------------------------------------------------------
  app.get('/api/airtime-cash/requests', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const snap = await db.ref(`airtimeCashRequests/${uid}`)
        .orderByChild('createdAt')
        .limitToLast(50)
        .once('value');

      const requests = [];
      snap.forEach(child => {
        const item = child.val();
        if (item) requests.push(publicRequest(item));
      });

      requests.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

      return res.json({ ok: true, requests });
    } catch (error) {
      return sendError(res, error, 'Could not load your Airtime to Cash requests.');
    }
  });

  // --------------------------------------------------------------------------
  // CUSTOMER: cancel only a request owned by the signed-in user and still
  // pending. A transaction prevents cancelling a request being reviewed.
  // --------------------------------------------------------------------------
  app.post('/api/airtime-cash/cancel', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const id = cleanText(req.body?.requestId || req.body?.id, 80);

      if (!/^ac_[a-f0-9]{32}$/.test(id)) {
        throw fail(400, 'Invalid request ID.');
      }

      const requestRef = db.ref(`airtimeCashRequests/${uid}/${id}`);
      let cancelled = false;

      const result = await requestRef.transaction(current => {
        cancelled = false;
        if (!current || current.status !== 'pending') return;
        cancelled = true;
        return {
          ...current,
          status: 'cancelled',
          updatedAt: now()
        };
      });

      if (!result.committed) {
        throw fail(409, 'This request cannot be cancelled. It may already be under review.');
      }

      const request = result.snapshot.val();

      return res.json({
        ok: true,
        request: publicRequest(request),
        message: 'Your request has been cancelled.'
      });
    } catch (error) {
      return sendError(res, error, 'Could not cancel this request.');
    }
  });

  // --------------------------------------------------------------------------
  // SUPER ADMIN: configure Airtime to Cash.
  // --------------------------------------------------------------------------
  app.post('/api/airtime-cash/admin/config', async (req, res) => {
    try {
      const actor = await getSuperAdmin(requireAdmin, req);
      const body = req.body || {};

      const minAmount = Number(body.minAmount);
      const maxAmount = Number(body.maxAmount);
      const payoutPercent = Number(body.payoutPercent);

      if (!Number.isSafeInteger(minAmount) || minAmount < 1) {
        throw fail(400, 'Minimum amount must be a positive whole number.');
      }
      if (!Number.isSafeInteger(maxAmount) || maxAmount < minAmount) {
        throw fail(400, 'Maximum amount must be greater than or equal to the minimum.');
      }
      if (!Number.isFinite(payoutPercent) || payoutPercent <= 0 || payoutPercent > 100) {
        throw fail(400, 'Payout percentage must be above 0 and no more than 100.');
      }

      const networks = Array.isArray(body.networks) ? body.networks : [];
      const cleanNetworks = [];

      for (const item of networks) {
        const network = cleanText(item?.network, 20).toUpperCase();
        const number = cleanText(item?.number, 30).replace(/\s+/g, '');

        if (!ALLOWED_NETWORKS.has(network)) {
          throw fail(400, `Unsupported network: ${network || 'unknown'}.`);
        }
        if (item?.enabled === true && !/^0\d{10}$/.test(number)) {
          throw fail(400, `Enter a valid 11-digit receiver number for ${network}.`);
        }

        cleanNetworks.push({
          network,
          number,
          enabled: item?.enabled === true
        });
      }

      const uniqueNetworks = new Set(cleanNetworks.map(n => n.network));
      if (uniqueNetworks.size !== cleanNetworks.length) {
        throw fail(400, 'Each network can only be configured once.');
      }

      const enabledNetworks = cleanNetworks.filter(n => n.enabled && n.number);
      const enabled = body.enabled === true && enabledNetworks.length > 0;

      const config = {
        enabled,
        minAmount,
        maxAmount,
        payoutPercent,
        networks: cleanNetworks,
        updatedAt: now(),
        updatedBy: actor.uid || actor.id || 'super_admin'
      };

            if (typeof writeAudit === 'function') {
        await writeAudit(
          actor,
          'airtime_cash_config_updated',
          'airtime_cash_config',
          'settings',
          'Airtime to Cash settings updated',
          null,
          {
            enabled,
            minAmount,
            maxAmount,
            payoutPercent,
            enabledNetworks: enabledNetworks.map(n => n.network)
          }
        );
  }

      return res.json({
        ok: true,
        config: normalizeConfig(config),
        message: enabled
          ? 'Airtime to Cash settings saved.'
          : 'Settings saved. Airtime to Cash remains disabled.'
      });

    } catch (error) {
      return sendError(res, error, 'Could not save Airtime to Cash settings.');
    }
  });

  // --------------------------------------------------------------------------
  // SUPER ADMIN: review queue across all users.
  // --------------------------------------------------------------------------
  app.get('/api/airtime-cash/admin/requests', async (req, res) => {
    try {
      await getSuperAdmin(requireAdmin, req);

      const snap = await db.ref('airtimeCashRequests').once('value');
      const requests = [];

      snap.forEach(userSnapshot => {
        userSnapshot.forEach(requestSnapshot => {
          const item = requestSnapshot.val();
          if (item) {
            requests.push({
              ...publicRequest(item),
              uid: item.uid || userSnapshot.key
            });
          }
        });
      });

      requests.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));

      return res.json({
        ok: true,
        requests: requests.slice(0, 200)
      });

    } catch (error) {
      return sendError(res, error, 'Could not load the Airtime to Cash review queue.');
    }
  });

  // --------------------------------------------------------------------------
  // SUPER ADMIN: approve, reject, or mark a request as processing.
  // Approval credits the wallet once, after the airtime has actually been
  // received and verified by the administrator.
  // --------------------------------------------------------------------------
  app.post('/api/airtime-cash/admin/review', async (req, res) => {
    try {
      const actor = await getSuperAdmin(requireAdmin, req);
      const body = req.body || {};

      const uid = cleanText(body.uid, 128);
      const id = cleanText(body.requestId || body.id, 80);
      const action = cleanText(body.action, 30).toLowerCase();
      const rejectReason = cleanText(body.rejectReason || body.reason, 250);

      if (!uid || !/^ac_[a-f0-9]{32}$/.test(id)) {
        throw fail(400, 'A valid user ID and request ID are required.');
      }

      if (!['processing', 'approve', 'reject'].includes(action)) {
        throw fail(400, 'Choose processing, approve, or reject.');
      }

      const requestRef = db.ref(`airtimeCashRequests/${uid}/${id}`);
      const requestSnap = await requestRef.once('value');
      const request = requestSnap.val();

      if (!request) throw fail(404, 'Airtime to Cash request was not found.');

      if (action === 'processing') {
        let updated = null;

        const result = await requestRef.transaction(current => {
          if (!current || current.status !== 'pending') return;
          updated = {
            ...current,
            status: 'processing',
            reviewedBy: actor.uid || actor.id || 'super_admin',
            updatedAt: now()
          };
          return updated;
        });

        if (!result.committed) {
          throw fail(409, 'This request is no longer pending.');
        }

        if (typeof writeAudit === 'function') {
  await writeAudit(
    actor,
    'airtime_cash_marked_processing',
    'airtime_cash_request',
    `${uid}/${id}`,
    'Request marked as processing'
  );
        }

        return res.json({
          ok: true,
          request: publicRequest(result.snapshot.val()),
          message: 'Request marked as processing.'
        });
      }

      if (action === 'reject') {
        if (request.status === 'approved' || request.status === 'credited') {
          throw fail(409, 'An already credited request cannot be rejected.');
        }

        const result = await requestRef.transaction(current => {
          if (!current || !['pending', 'processing'].includes(current.status)) return;
          return {
            ...current,
            status: 'rejected',
            rejectReason: rejectReason || 'Request could not be verified.',
            reviewedBy: actor.uid || actor.id || 'super_admin',
            updatedAt: now()
          };
        });

        if (!result.committed) {
          throw fail(409, 'This request can no longer be rejected.');
        }

        if (typeof writeAudit === 'function') {
  await writeAudit(
    actor,
    'airtime_cash_request_rejected',
    'airtime_cash_request',
    `${uid}/${id}`,
    rejectReason || 'Request could not be verified.'
  );
            }

        return res.json({
          ok: true,
          request: publicRequest(result.snapshot.val()),
          message: 'Request rejected. No wallet credit was made.'
        });
      }

      // APPROVAL:
      // Do not approve unless an administrator has independently verified
      // that the airtime has arrived at the configured receiving line.
      if (!['pending', 'processing', 'approving', 'approved', 'credited'].includes(request.status)) {
        throw fail(409, 'This request cannot be approved in its current status.');
      }

      const payout = Number(request.payout);
      if (!Number.isSafeInteger(payout) || payout <= 0) {
        throw fail(400, 'The request has an invalid payout amount.');
      }

      const creditMarkerRef = db.ref(`airtimeCashCredits/${id}`);
      const existingMarker = (await creditMarkerRef.once('value')).val();

      if (!existingMarker) {
        const lockResult = await requestRef.transaction(current => {
          if (!current) return;
          if (['approved', 'credited'].includes(current.status)) return;
          if (!['pending', 'processing', 'approving'].includes(current.status)) return;

          return {
            ...current,
            status: 'approving',
            reviewedBy: actor.uid || actor.id || 'super_admin',
            updatedAt: now()
          };
        });

        if (!lockResult.committed) {
          throw fail(409, 'This request is already being reviewed or cannot be approved.');
        }
      }

      const userRef = db.ref(`users/${uid}`);
      let alreadyCredited = false;

      const creditResult = await userRef.transaction(user => {
        alreadyCredited = false;
        if (!user) return;

        user = { ...user };
        user.airtimeCashCredits = user.airtimeCashCredits || {};

        if (user.airtimeCashCredits[id]) {
          alreadyCredited = true;
          return user;
        }

        const currentBalance = Number(user.walletBalance || 0);
        if (!Number.isFinite(currentBalance) || currentBalance < 0) return;

        user.walletBalance = currentBalance + payout;
        user.airtimeCashCredits[id] = {
          amount: payout,
          creditedAt: now(),
          requestId: id
        };

        return user;
      });

      if (!creditResult.committed) {
        throw fail(500, 'Wallet credit could not be completed. The request remains protected against duplicate credit.');
      }

      const finalUser = creditResult.snapshot.val();
      const creditRecord = finalUser?.airtimeCashCredits?.[id];

      if (!creditRecord) {
        throw fail(500, 'Wallet credit could not be verified.');
      }

            // Create the central credit marker. The user's wallet transaction above
      // is the authoritative duplicate-credit protection.
      await creditMarkerRef.set({
        uid,
        requestId: id,
        amount: payout,
        creditedAt: creditRecord.creditedAt || now(),
        creditedBy: actor.uid || actor.id || 'super_admin'
      });

      // Record wallet history.
await db.ref(`walletLedger/${uid}/${id}`).set({
  type: 'airtime_to_cash',
  direction: 'credit',
  category: 'airtime_to_cash',
  amount: payout,
  description: 'Airtime to Cash payout',
  reference: id,
  status: 'completed',
  createdAt: creditRecord.creditedAt || now()
});

      // Keep the user's transaction history in sync.
await db.ref(`users/${uid}/transactions/${id}`).set({
  type: 'airtime_to_cash',
  direction: 'credit',
  category: 'airtime_to_cash',
  amount: payout,
  description: 'Airtime to Cash payout',
  reference: id,
  status: 'completed',
  createdAt: creditRecord.creditedAt || now()
});
      await requestRef.update({
        status: 'approved',
        credited: true,
        creditedAmount: payout,
        creditedAt: creditRecord.creditedAt || now(),
        reviewedBy: actor.uid || actor.id || 'super_admin',
        updatedAt: now()
      });

      if (typeof writeAudit === 'function') {
  await writeAudit(
    actor,
    'airtime_cash_request_approved',
    'airtime_cash_request',
    `${uid}/${id}`,
    'Airtime verified and payout approved',
    null,
    { amount: payout, alreadyCredited }
  );
        }

      return res.json({
        ok: true,
        alreadyCredited,
        creditedAmount: payout,
        message: alreadyCredited
          ? 'This request was already credited. No duplicate wallet credit was made.'
          : 'Request approved and wallet credited successfully.'
      });

    } catch (error) {
      return sendError(res, error, 'Could not review this Airtime to Cash request.');
    }
  });
}

export default registerAirtimeCash;
