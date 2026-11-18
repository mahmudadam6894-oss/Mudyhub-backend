// MudyHub V1 — server-authoritative daily and referral rewards.
// Register with: registerRewards({ app, admin, db, authenticatedUid });
// Server-authoritative rewards. Browsers can no longer write wallet balances or claim records.
// Note: daily and referral bonuses are credited to wallet balances without a funding source. Keep DAILY_BONUS
// and REFERRAL_BONUS small and cap the total per day before you rely on them.
export default function registerRewards({ app, admin, db, authenticatedUid }) {
  const DAILY_BONUS = 2;
  const REFERRAL_BONUS = 50;
  const COOLDOWN = 24 * 60 * 60 * 1000;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const sendError = (res, e) => {
    const status = e.status || (e.message === 'Unauthorized' ? 401 : 500);
    if (status === 500) console.error('Rewards route error:', e);
    return res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
  };
  async function verifiedUser(req) {
    const uid = await authenticatedUid(req);
    const authUser = await admin.auth().getUser(uid);
    if (!authUser.emailVerified) throw fail(403, 'Verify your email address before claiming rewards.');
    const snap = await db.ref(`users/${uid}`).once('value');
    if (!snap.exists()) throw fail(404, 'User account not found.');
    const user = snap.val();
    if (user.banned === true || user.status === 'banned' || user.walletFrozen === true) throw fail(403, 'Your account or wallet is restricted.');
    return { uid, user };
  }

  app.post('/api/rewards/daily/claim', async (req, res) => {
    try {
      const { uid } = await verifiedUser(req);
      const now = Date.now();
      let already = false, nextClaimAt = 0;
      const result = await db.ref(`users/${uid}`).transaction(user => {
        if (!user) return user;
        const claims = user.serverRewardClaims || {};
        const previous = Number(claims.daily?.claimedAt || 0);
        if (previous && now - previous < COOLDOWN) {
          already = true; nextClaimAt = previous + COOLDOWN; return;
        }
        user.walletBalance = Number(user.walletBalance || 0) + DAILY_BONUS;
        user.lifetimeEarned = Number(user.lifetimeEarned || 0) + DAILY_BONUS;
        claims.daily = { claimedAt: now, amount: DAILY_BONUS };
        user.serverRewardClaims = claims;
        return user;
      });
      if (!result.committed) {
        if (already) return res.status(409).json({ error: 'Daily reward already claimed.', nextClaimAt });
        return res.status(409).json({ error: 'Daily reward could not be claimed. Refresh and try again.' });
      }
      await db.ref(`dailyClaims/${uid}`).set({ lastClaimedTimestamp: now });
      await db.ref(`walletLedger/${uid}/daily_${now}`).set({ type: 'daily_reward', direction: 'credit', amount: DAILY_BONUS, description: 'Daily loyalty reward', status: 'completed', createdAt: now });
      await db.ref(`notifications/${uid}/daily_${now}`).set({ type: 'daily_bonus', amount: DAILY_BONUS, message: `Daily bonus: ₦${DAILY_BONUS.toFixed(2)} credited to your wallet.`, createdAt: now, read: false });
      return res.json({ ok: true, amount: DAILY_BONUS, claimedAt: now, nextClaimAt: now + COOLDOWN, balance: Number(result.snapshot.val()?.walletBalance || 0) });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/rewards/referrals/claim', async (req, res) => {
    try {
      const { uid } = await verifiedUser(req);
      const pendingRef = db.ref(`pendingReferrals/${uid}`);
      const snap = await pendingRef.once('value');
      if (!snap.exists()) throw fail(400, 'There are no pending referral rewards.');
      const pending = snap.val();
      const ids = Object.keys(pending).filter(id => pending[id] && pending[id].claimed !== true && /^[A-Za-z0-9_-]{1,120}$/.test(id));
      if (!ids.length) throw fail(400, 'There are no pending referral rewards.');
      let creditedCount = 0;
      const now = Date.now();
      const result = await db.ref(`users/${uid}`).transaction(user => {
        if (!user) return user;
        const claims = user.serverRewardClaims || {};
        const referralClaims = claims.referrals || {};
        let count = 0;
        for (const id of ids) {
          if (!referralClaims[id]) { referralClaims[id] = now; count++; }
        }
        if (!count) return user;              // nothing new: commit without changing the wallet
        const amount = count * REFERRAL_BONUS;
        user.walletBalance = Number(user.walletBalance || 0) + amount;
        user.lifetimeEarned = Number(user.lifetimeEarned || 0) + amount;
        claims.referrals = referralClaims;
        user.serverRewardClaims = claims;
        creditedCount = count;
        return user;
      });
      if (!result.committed) throw fail(409, 'These referral rewards could not be claimed. Refresh and try again.');
      const amount = creditedCount * REFERRAL_BONUS;
      const updates = {};
      for (const id of ids) { updates[`${id}/claimed`] = true; updates[`${id}/claimedAt`] = now; }
      await pendingRef.update(updates);   // mark every listed referral as handled, even if it paid nothing this time
      if (creditedCount > 0) {
        await db.ref(`walletLedger/${uid}/referrals_${now}`).set({ type: 'referral_reward', direction: 'credit', amount, count: creditedCount, description: `${creditedCount} referral reward(s)`, status: 'completed', createdAt: now });
        await db.ref(`notifications/${uid}/referrals_${now}`).set({ type: 'referral_claimed', amount, message: `You claimed ₦${amount.toFixed(2)} from ${creditedCount} referral(s).`, createdAt: now, read: false });
      }
      return res.json({ ok: true, count: creditedCount, amount, alreadyClaimed: creditedCount === 0, balance: Number(result.snapshot.val()?.walletBalance || 0) });
    } catch (e) { return sendError(res, e); }
  });
}
