// MudyHub V1 — Promote (user-published campaigns & ads), server-side money handling.
// Registered from server.js:
//   registerPromote({ app, admin, db, authenticatedUid });
//
//   POST /api/promote/create   { kind: 'campaign'|'ad', requestId, ...fields }
//   POST /api/promote/cancel   { id, kind }          (owner cancels while still pending review)
//
// The browser can no longer write to /campaigns or /adminAds (see database rules). The server:
//   1. identifies the user from the Firebase ID token,
//   2. validates every number itself,
//   3. takes reward x slots from the wallet in one atomic step and writes a ledger entry,
//   4. creates the item as "pending" (admin review is still required),
//   5. returns the money exactly once if anything fails or the owner cancels.

export default function registerPromote({ app, admin, db, authenticatedUid }) {
  const LIMITS = {
    campaign: { minReward: 20, maxSlots: 10000, node: 'campaigns' },
    ad: { minReward: 10, maxSlots: 10000, node: 'adminAds' }
  };
  const MAX_TOTAL = Number(process.env.PROMOTE_MAX_TOTAL_NAIRA || 200000);
  const SAFE_ID = /^[A-Za-z0-9_-]{12,100}$/;
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const httpsUrl = v => { try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' ? u.toString().slice(0, 500) : null; } catch { return null; } };
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const respondError = (res, e) => {
    const status = e.status || (e.message === 'Unauthorized' ? 401 : 500);
    if (status === 500) console.error('Promote error:', e);
    return res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
  };

  async function creditBack(uid, amount, claimKey) {
    let already = false;
    const r = await db.ref(`users/${uid}`).transaction(user => {
      if (user === null) return user;
      const claims = user.adminRefundClaims || {};
      if (claims[claimKey]) { already = true; return user; }
      user.walletBalance = Number(user.walletBalance || 0) + amount;
      claims[claimKey] = { amount, at: Date.now() };
      user.adminRefundClaims = claims;
      return user;
    });
    if (!r.committed || !r.snapshot.exists()) throw new Error('Refund could not be committed.');
    return !already;
  }

  app.post('/api/promote/create', async (req, res) => {
    let uid = null, debited = false, total = 0, requestId = '', claimRef = null, itemRef = null;
    try {
      uid = await authenticatedUid(req);
      const b = req.body || {};
      const kind = b.kind === 'ad' ? 'ad' : b.kind === 'campaign' ? 'campaign' : null;
      if (!kind) throw fail(400, 'Unknown promotion type.');
      requestId = String(b.requestId || '').trim();
      if (!SAFE_ID.test(requestId)) throw fail(400, 'Invalid request ID.');
      const lim = LIMITS[kind];

      const title = clean(b.title, 120);
      const reward = Number(b.reward);
      const slots = Number(b.slots);
      if (title.length < (kind === 'ad' ? 3 : 5)) throw fail(400, kind === 'ad' ? 'Business name must be at least 3 characters.' : 'Title must be at least 5 characters.');
      if (!Number.isSafeInteger(reward) || reward < lim.minReward) throw fail(400, `Minimum reward is ₦${lim.minReward} (whole naira).`);
      if (!Number.isSafeInteger(slots) || slots < 1 || slots > lim.maxSlots) throw fail(400, `Slots must be between 1 and ${lim.maxSlots}.`);
      total = reward * slots;
      if (!Number.isSafeInteger(total) || total > MAX_TOTAL) throw fail(400, `The total budget cannot exceed ₦${MAX_TOTAL.toLocaleString()}.`);

      let item;
      if (kind === 'campaign') {
        const link = httpsUrl(b.link);
        const description = clean(b.description, 1500);
        const duration = Number(b.duration || 0);
        if (!link) throw fail(400, 'Enter a valid target link starting with https://');
        if (description.length < 20) throw fail(400, 'Instructions must be at least 20 characters.');
        if (!Number.isInteger(duration) || duration < 0 || duration > 3600) throw fail(400, 'Timer must be between 0 and 3600 seconds.');
        const category = clean(b.category, 30).toLowerCase().replace(/[^a-z0-9_ -]/g, '') || 'task';
        item = { title, category, targetUrl: link, reward, totalSlots: slots, completedSlots: 0, duration, instructions: description };
      } else {
        const videoUrl = httpsUrl(b.videoUrl), actionLink = httpsUrl(b.actionLink);
        const duration = Number(b.duration || 30);
        if (!videoUrl) throw fail(400, 'Enter a valid video link starting with https://');
        if (!actionLink) throw fail(400, 'Enter a valid action link starting with https://');
        if (!Number.isInteger(duration) || duration < 5 || duration > 600) throw fail(400, 'Watch time must be between 5 and 600 seconds.');
        item = { title, videoUrl, actionLink, rewardPerView: reward, totalSlots: slots, viewsCompleted: 0, duration };
      }

      // Who is allowed to spend?
      const authUser = await admin.auth().getUser(uid);
      if (!authUser.emailVerified) throw fail(403, 'Verify your email address before promoting.');
      const userSnap = await db.ref(`users/${uid}`).once('value');
      const user = userSnap.val();
      if (!user) throw fail(404, 'User not found.');
      if (user.banned === true || user.status === 'banned' || user.walletFrozen === true) throw fail(403, 'Your account or wallet is restricted. Contact support.');

      // Idempotency: one request ID is processed once.
      claimRef = db.ref(`promoteRequests/${uid}/${requestId}`);
      const claim = await claimRef.transaction(cur => cur ? undefined : { state: 'processing', kind, total, at: Date.now() });
      if (!claim.committed) throw fail(409, 'This request was already submitted.');

      // Take the money atomically.
      let canDebit = false;
      const debit = await db.ref(`users/${uid}/walletBalance`).transaction(cur => {
        canDebit = false;
        if (cur === null) return 0;              // Firebase retries with the real value
        const bal = Number(cur);
        if (!Number.isFinite(bal) || bal < total) return;
        canDebit = true;
        return bal - total;
      });
      if (!debit.committed || !canDebit) { await claimRef.remove().catch(() => {}); throw fail(400, 'Insufficient wallet balance.'); }
      debited = true;

      itemRef = db.ref(lim.node).push();
      const now = Date.now();
      await itemRef.set({
        ...item,
        creatorId: uid,
        creatorName: clean(user.fullName || user.username || 'MudyHub User', 80),
        creatorAvatar: clean(user.avatarUrl || '', 500),
        totalEscrowLocked: total,
        status: 'pending',
        createdAt: now,
        requestId
      });
      await db.ref(`walletLedger/${uid}/promote_${requestId}`).set({
        type: kind === 'ad' ? 'ad_escrow' : 'campaign_escrow', direction: 'debit', amount: total,
        reference: itemRef.key, description: `Escrow locked for ${kind}: ${title}`, status: 'completed', createdAt: now
      });
      await claimRef.update({ state: 'done', id: itemRef.key });
      return res.json({ ok: true, id: itemRef.key, status: 'pending', escrowLocked: total, newBalance: Number(debit.snapshot.val()) });
    } catch (e) {
      // If the money was taken but the item was not saved, return it once.
      if (debited && uid) {
        try {
          if (itemRef) await itemRef.remove().catch(() => {});
          await creditBack(uid, total, `promote_failed_${requestId}`);
          if (claimRef) await claimRef.update({ state: 'refunded' }).catch(() => {});
        } catch (re) { console.error('Promote rollback failed:', re); }
      }
      return respondError(res, e);
    }
  });

  app.post('/api/promote/cancel', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const id = String(req.body?.id || '').trim();
      const node = req.body?.kind === 'ad' ? 'adminAds' : 'campaigns';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw fail(400, 'Invalid ID.');
      const itemRef = db.ref(`${node}/${id}`);
      const snap = await itemRef.once('value');
      if (!snap.exists()) throw fail(404, 'Not found.');
      const item = snap.val();
      if (item.creatorId !== uid) throw fail(403, 'This is not your promotion.');
      if (item.status !== 'pending') throw fail(400, 'Only promotions awaiting review can be cancelled. Contact support for live ones.');
      const escrow = Math.max(0, Number(item.totalEscrowLocked || 0));
      // Same claim key the admin "reject" uses, so a cancel and a rejection can never both refund.
      const refunded = escrow > 0 ? await creditBack(uid, escrow, `campaign_${id}`) : false;
      await itemRef.update({ status: 'cancelled', cancelledAt: Date.now(), totalEscrowLocked: 0, escrowReleasedAt: Date.now() });
      if (refunded) {
        await db.ref(`walletLedger/${uid}/campaign_refund_${id}`).set({
          type: 'campaign_refund', direction: 'credit', amount: escrow, reference: id,
          description: 'Refund for cancelled Promote item', status: 'completed', createdAt: Date.now()
        });
      }
      return res.json({ ok: true, status: 'cancelled', refunded: refunded ? escrow : 0 });
    } catch (e) { return respondError(res, e); }
  });
}
