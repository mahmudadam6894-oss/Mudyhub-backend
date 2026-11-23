// MudyHub V1 — extra admin routes (ES module).
// Registered from server.js:
// registerAdminV1({ app, admin, db, requireAdmin, writeAudit, adminResponseError });
//
// All privileged actions are authorised by the backend.
// The browser is never trusted to grant admin permissions.
//
// Permission groups:
// super, support, verification, moderation, withdrawals,
// business, tc:moderate

export default function registerAdminV1({
  app,
  admin,
  db,
  requireAdmin,
  writeAudit,
  adminResponseError
}) {
  const val = async path =>
    (await db.ref(path).once('value')).val();

  const clean = (v, max) =>
    String(v == null ? '' : v)
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, max);

  const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;

  const route = (path, handler) =>
    app.post(path, async (req, res) => {
      try {
        return res.json({
          ok: true,
          ...(await handler(req, req.body || {}))
        });
      } catch (e) {
        return adminResponseError(res, e);
      }
    });

  const anyOf = async (req, perms) => {
    let lastErr;

    for (const p of perms) {
      try {
        return await requireAdmin(req, p);
      } catch (e) {
        lastErr = e;

        if (e.message === 'Unauthorized') {
          throw e;
        }
      }
    }

    throw lastErr || new Error('Forbidden');
  };

  const requireReason = (reason, min = 8) => {
    const value = clean(reason, 500);

    if (value.length < min) {
      throw new Error(
        `Write a clear reason (at least ${min} characters).`
      );
    }

    return value;
  };

  const safeId = (v, what = 'ID') => {
    const s = clean(v, 160);

    if (!SAFE_ID.test(s)) {
      throw new Error(`Invalid ${what}.`);
    }

    return s;
  };

  // ------------------------------------------------------------
  // SAFE, ONE-TIME WALLET CREDIT
  // Used for rejected KYC application refunds.
  // ------------------------------------------------------------

  async function creditOnce(uid, claimKey, amount) {
    let already = false;

    const r = await db.ref(`users/${uid}`).transaction(user => {
      if (user === null) return user;

      const claims = user.adminRefundClaims || {};

      if (claims[claimKey]) {
        already = true;
        return user;
      }

      user.walletBalance =
        Math.round(
          (Number(user.walletBalance || 0) + amount) * 100
        ) / 100;

      claims[claimKey] = {
        amount,
        at: Date.now()
      };

      user.adminRefundClaims = claims;

      return user;
    });

    if (!r.committed || !r.snapshot.exists()) {
      throw new Error(
        'Refund could not be completed. Check the account and try again.'
      );
    }

    return { already };
  }

  // ------------------------------------------------------------
  // USER STATISTICS — SUPER ADMIN ONLY
  // ------------------------------------------------------------

  route('/api/admin/users/stats', async req => {
    await requireAdmin(req, 'super');

    const users = (await val('users')) || {};

    const records = Object.values(users).filter(
      u => u && typeof u === 'object'
    );

    let active = 0;
    let restricted = 0;
    let verified = 0;

    for (const u of records) {
      if (
        u.banned === true ||
        u.status === 'banned' ||
        u.status === 'restricted'
      ) {
        restricted++;
      } else {
        active++;
      }

      if (
        u.verified === true ||
        u.kycStatus === 'approved'
      ) {
        verified++;
      }
    }

    return {
      totalUsers: records.length,
      activeUsers: active,
      restrictedUsers: restricted,
      verifiedUsers: verified
    };
  });
  
  // ------------------------------------------------------------
  // REGISTERED USER DIRECTORY — SUPER ADMIN ONLY
  // Paginated, safe user information only.
  // ------------------------------------------------------------

  route('/api/admin/users/list', async (req, b) => {
    await requireAdmin(req, 'super');

    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(b.limit) || 50))
    );

    const cursor = b.cursor
      ? safeId(b.cursor, 'pagination cursor')
      : null;

    let q = db.ref('users').orderByKey();

    if (cursor) {
      q = q.startAfter(cursor);
    }

    const snap = await q
      .limitToFirst(limit + 1)
      .once('value');

    const entries = Object.entries(snap.val() || {});
    const hasMore = entries.length > limit;
    const page = entries.slice(0, limit);

    const users = page.map(([uid, u]) => ({
      uid,
      fullName: clean(u.fullName || u.fullname || u.name, 100),
      username: clean(u.username, 40),
      email: clean(u.email, 120),
      createdAt: Number(u.createdAt || u.created_at || 0),
      verified:
        u.verified === true ||
        u.kycStatus === 'approved',
      banned:
        u.banned === true ||
        u.status === 'banned',
      walletFrozen: u.walletFrozen === true
    }));

    return {
      users,
      nextCursor: hasMore ? page[page.length - 1][0] : null
    };
  });

  // ------------------------------------------------------------
  // USER WALLET HISTORY — SUPER ADMIN ONLY
  // ------------------------------------------------------------

  route('/api/admin/user/wallet-history', async (req, b) => {
    await requireAdmin(req, 'super');

    const uid = safeId(b.uid, 'user ID');

    const snap = await db
      .ref(`walletLedger/${uid}`)
      .orderByChild('createdAt')
      .limitToLast(50)
      .once('value');

    const items = Object.entries(snap.val() || {})
      .map(([id, x]) => ({
        id,
        type: clean(x.type, 60),
        direction: clean(x.direction, 20),
        amount: Number(x.amount || 0),
        description: clean(x.description, 200),
        status: clean(x.status, 40),
        createdAt: Number(x.createdAt || 0)
      }))
      .sort((a, b) => b.createdAt - a.createdAt);

    return { items };
  });

  // ------------------------------------------------------------
  // ADMIN WALLET ADJUSTMENT — SUPER ADMIN ONLY
  // Positive amount credits; negative amount debits.
  // The user balance is changed transactionally and every change is logged.
  // ------------------------------------------------------------

  route('/api/admin/wallet/adjust', async (req, b) => {
    const actor = await requireAdmin(req, 'super');
    const uid = safeId(b.uid, 'user ID');
    const rawAmount = Number(b.amount);
    const reason = requireReason(b.reason, 10);

    if (uid === actor.uid) {
      throw new Error('You cannot adjust your own wallet.');
    }

    if (
      !Number.isFinite(rawAmount) ||
      rawAmount === 0 ||
      Math.abs(rawAmount) > 1000000
    ) {
      throw new Error(
        'Enter a valid non-zero amount. Maximum adjustment is ₦1,000,000.'
      );
    }

    const amount = Math.round(rawAmount * 100) / 100;

    if (Math.abs(amount - rawAmount) > 0.000001) {
      throw new Error(
        'Wallet adjustments can have no more than 2 decimal places.'
      );
    }

    const userRef = db.ref(`users/${uid}`);
    const beforeSnap = await userRef.once('value');

    if (!beforeSnap.exists()) {
      throw new Error('User not found.');
    }

    const beforeBalance = Number(
      beforeSnap.val()?.walletBalance || 0
    );

    if (
      !Number.isFinite(beforeBalance) ||
      beforeBalance < 0
    ) {
      throw new Error(
        'The user wallet balance is invalid. Review the account before adjusting it.'
      );
    }

    const adjustmentId = db.ref(`walletLedger/${uid}`).push().key;

    if (!adjustmentId) {
      throw new Error(
        'Could not create a wallet adjustment reference.'
      );
    }

    const now = Date.now();

    const ledgerRef = db.ref(
      `walletLedger/${uid}/${adjustmentId}`
    );

    // Create a processing ledger record first.
    await ledgerRef.set({
      type: 'admin_adjustment',
      direction: amount > 0 ? 'credit' : 'debit',
      amount: Math.abs(amount),
      signedAmount: amount,
      reference: adjustmentId,
      description: reason,
      status: 'processing',
      createdAt: now,
      adminUid: actor.uid,
      adminName: clean(actor.name || 'Admin', 100)
    });

    let insufficientBalance = false;

    // Update the user's wallet transactionally.
    const result = await userRef.transaction(user => {
      if (user === null) return user;

      const claims = user.adminWalletAdjustments || {};

      // Prevent the same adjustment reference being applied twice.
      if (claims[adjustmentId]) return user;

      const current = Number(user.walletBalance || 0);

      if (!Number.isFinite(current) || current < 0) {
        return;
      }

      const next = Math.round(
        (current + amount) * 100
      ) / 100;

      if (!Number.isFinite(next) || next < 0) {
        insufficientBalance = true;
        return;
      }

      user.walletBalance = next;

      claims[adjustmentId] = {
        amount,
        reason,
        by: actor.uid,
        at: now
      };

      user.adminWalletAdjustments = claims;

      return user;
    });

    if (!result.committed || !result.snapshot.exists()) {
      await ledgerRef.update({
        status: 'failed',
        failedAt: Date.now(),
        failureReason: insufficientBalance
          ? 'Insufficient wallet balance.'
          : 'Wallet transaction was not committed.'
      });

      throw new Error(
        insufficientBalance
          ? 'Insufficient wallet balance. The debit was not applied.'
          : 'Wallet adjustment was not committed. No balance change was confirmed.'
      );
    }

    const balanceAfter = Number(
      result.snapshot.val()?.walletBalance || 0
    );

    // Mark the ledger record completed.
    await ledgerRef.update({
      status: 'completed',
      completedAt: Date.now(),
      balanceBefore: beforeBalance,
      balanceAfter
    });

    // Record the action in the admin audit log.
    await writeAudit(
      actor,
      'admin_wallet_adjustment',
      'userWallet',
      uid,
      reason,
      {
        balanceBefore: beforeBalance
      },
      {
        amount,
        adjustmentId,
        balanceAfter
      }
    );

    // Notify the affected user.
    await db.ref(
      `notifications/${uid}/wallet_adjust_${adjustmentId}`
    ).set({
      type: 'wallet_adjustment',
      amount,
      message: amount > 0
        ? `An admin adjustment of ₦${amount.toLocaleString()} was credited to your wallet.`
        : `An admin adjustment of ₦${Math.abs(amount).toLocaleString()} was debited from your wallet.`,
      createdAt: Date.now(),
      read: false
    });

    return {
      adjustmentId,
      balance: balanceAfter
    };
  });
        

  // ------------------------------------------------------------
  // ADMIN NOTIFICATION — SUPER ADMIN ONLY
  // ------------------------------------------------------------

  route('/api/admin/user/notify', async (req, b) => {
    const actor = await requireAdmin(req, 'super');

    const uid = safeId(b.uid, 'User ID');
    const message = clean(b.message, 500);

    if (message.length < 5) {
      throw new Error(
        'Write a notification of at least 5 characters.'
      );
    }

    const user = await val(`users/${uid}`);

    if (!user) {
      throw new Error('User not found.');
    }

    const now = Date.now();

    const notification = {
      type: 'admin_notice',
      title: clean(b.title || 'MudyHub Notice', 80),
      message,
      createdAt: now,
      read: false,
      sentBy: actor.uid
    };

    const pushed = await db
      .ref(`notifications/${uid}`)
      .push(notification);

    await writeAudit(
      actor,
      'notify_user',
      'user',
      uid,
      message,
      null,
      { notificationId: pushed.key }
    );

    return {
      notificationId: pushed.key
    };
  });

  // ------------------------------------------------------------
  // OFFICIAL USER WARNING — SUPER ADMIN ONLY
  // ------------------------------------------------------------

  route('/api/admin/user/warn', async (req, b) => {
    const actor = await requireAdmin(req, 'super');

    const uid = safeId(b.uid, 'User ID');
    const reason = requireReason(b.reason, 8);

    const user = await val(`users/${uid}`);

    if (!user) {
      throw new Error('User not found.');
    }

    const now = Date.now();

    const warningRef = db
      .ref(`userWarnings/${uid}`)
      .push();

    const warning = {
      uid,
      reason,
      status: 'active',
      issuedAt: now,
      issuedBy: actor.uid,
      adminName: clean(
        actor.name || 'MudyHub Admin',
        80
      )
    };

    await warningRef.set(warning);

    await db.ref(`notifications/${uid}`).push({
      type: 'admin_warning',
      title: 'Official MudyHub Warning',
      message:
        `MudyHub has issued an official warning to your account. Reason: ${reason}`,
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      'warn_user',
      'user',
      uid,
      reason,
      null,
      { warningId: warningRef.key }
    );

    return {
      warningId: warningRef.key
    };
  });

  // ------------------------------------------------------------
  // USER LOOKUP
  // ------------------------------------------------------------

  route('/api/admin/user/lookup', async (req, b) => {
    const actor = await anyOf(req, [
      'support',
      'verification',
      'withdrawals',
      'trueConnection'
    ]);

    const q = clean(b.query, 120);

    if (q.length < 3) {
      throw new Error(
        'Type at least 3 characters (email, username or user ID).'
      );
    }

    let found = {};

    if (/^[A-Za-z0-9_-]{20,128}$/.test(q)) {
      const u = await val(`users/${q}`);

      if (u) {
        found[q] = u;
      }
    }

    if (!Object.keys(found).length && q.includes('@')) {
      for (const email of new Set([
        q,
        q.toLowerCase()
      ])) {
        const s = await db
          .ref('users')
          .orderByChild('email')
          .equalTo(email)
          .limitToFirst(5)
          .once('value');

        found = {
          ...found,
          ...(s.val() || {})
        };
      }
    }

    if (!Object.keys(found).length) {
      const uname = q.replace(/^@/, '');

      for (const name of new Set([
        uname,
        uname.toLowerCase()
      ])) {
        const s = await db
          .ref('users')
          .orderByChild('username')
          .equalTo(name)
          .limitToFirst(5)
          .once('value');

        found = {
          ...found,
          ...(s.val() || {})
        };
      }
    }

    const seeBalance =
      actor.role === 'super_admin' ||
      actor.permissions?.withdrawals === true;

    const users = Object.entries(found)
      .slice(0, 5)
      .map(([uid, u]) => ({
        uid,
        fullName: u.fullName || u.fullname || '',
        username: u.username || '',
        email: u.email || '',
        phone: u.phone || '',

        avatarUrl:
          typeof u.avatarUrl === 'string' &&
          u.avatarUrl.length < 2000
            ? u.avatarUrl
            : '',

        banned: u.banned === true,
        status: u.status || 'active',

        verified:
          u.verified === true ||
          u.kycStatus === 'approved',

        kycStatus: u.kycStatus || '',
        walletFrozen: u.walletFrozen === true,
        createdAt: u.createdAt || null,

        ...(seeBalance
          ? {
              walletBalance: Number(
                u.walletBalance || 0
              ),
              lifetimeEarned: Number(
                u.lifetimeEarned || 0
              )
            }
          : {})
      }));

    return { users };
  });

  // ------------------------------------------------------------
  // MANUAL USER VERIFICATION
  // ------------------------------------------------------------

  // Returns one account to a brand-new state: removes money, earnings, PIN, verification and activity.
  // Keeps name, username, email, email-verified and join date. Super admin only, logged in the audit log.
  route('/api/admin/user/reset-fresh', async (req, b) => {
    const actor = await requireAdmin(req, 'super');
    const uid = safeId(b.uid, 'user ID');
    const reason = requireReason(b.reason);
    if (b.confirm !== 'RESET') throw new Error('Type RESET to confirm.');

    const u = await val(`users/${uid}`);
    if (!u) throw new Error('User not found.');

    const KEEP = ['fullName', 'fullname', 'username', 'email', 'emailVerified', 'joinedAt', 'createdAt'];
    const patch = {};
    const removed = [];
    for (const k of Object.keys(u)) {
      if (!KEEP.includes(k)) { patch[k] = null; removed.push(k); }
    }
    const removedValues = {};
    for (const k of removed) removedValues[k] = u[k];
    if (removed.length) await trashPut(actor, `users/${uid}`, 'merge', removedValues, 'Reset to new account: ' + reason);
    await db.ref(`users/${uid}`).update(patch);

    // Money and activity records that belong to this account (each one is kept in the trash first)
    for (const node of ['walletLedger', 'walletTopups', 'pendingPayouts', 'dailyClaims', 'referrals', 'pendingReferrals']) {
      const v = await val(`${node}/${uid}`);
      if (v !== null && v !== undefined) {
        await trashPut(actor, `${node}/${uid}`, 'set', v, 'Reset to new account: ' + reason);
        await db.ref(`${node}/${uid}`).remove();
      }
    }
    const wd = await db.ref('withdrawalRequests').orderByChild('uid').equalTo(uid).once('value');
    for (const [id, w] of Object.entries(wd.val() || {})) {
      await trashPut(actor, `withdrawalRequests/${id}`, 'set', w, 'Reset to new account: ' + reason);
      await db.ref(`withdrawalRequests/${id}`).remove();
    }

    await writeAudit(actor, 'user_reset_fresh', 'user', uid, reason, { removedFields: removed.length }, { fresh: true });
    return { uid, removedFields: removed.length };
  });

  // ---------- Data manager (super admin only). Every action is logged.
  const DATA_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
  const PROTECTED_NODES = ['admins', 'adminRoles', 'adminAuditLog', 'platformSettings', 'users', 'walletLedger',
    'walletTopups', 'withdrawalRequests', 'pendingPayouts', 'platformRevenue', 'verificationApplications', 'companies', 'campusVerifications'];
  const checkDataPath = p => {
    const s = String(p || '').trim().replace(/^\/+|\/+$/g, '');
    if (!s || s.length > 300 || !DATA_PATH.test(s)) throw new Error('Enter a valid path, for example statuses or users/abc123.');
    return s;
  };
  const isProtectedPath = p => PROTECTED_NODES.includes(p.split('/')[0]);
  const countOf = v => (v && typeof v === 'object') ? Object.keys(v).length : (v === null || v === undefined ? 0 : 1);

  // Keeps a copy of data before it is removed, so it can be restored. mode 'set' = put back the whole value,
  // 'merge' = put back only the fields that were removed.
  const trashPut = async (actor, path, mode, value, reason) => {
    const id = db.ref('dataTrash').push().key;
    await db.ref(`dataTrash/${id}`).set({
      path, mode, value, deletedAt: Date.now(), deletedBy: actor.uid, deletedByName: actor.name || '',
      reason: String(reason || ''), restoredAt: null, purgedAt: null
    });
    return id;
  };

  route('/api/admin/data/inspect', async (req, b) => {
    await requireAdmin(req, 'super');
    const p = checkDataPath(b.path);
    const v = await val(p);
    return {
      path: p, exists: v !== null && v !== undefined, protected: isProtectedPath(p),
      kind: v === null || v === undefined ? 'empty' : (typeof v === 'object' ? 'folder' : 'value'),
      children: countOf(v), deleteWord: isProtectedPath(p) ? `DELETE PROTECTED ${p}` : `DELETE ${p}`
    };
  });

  route('/api/admin/data/delete', async (req, b) => {
    const actor = await requireAdmin(req, 'super');
    const p = checkDataPath(b.path);
    const reason = requireReason(b.reason);
    const need = isProtectedPath(p) ? `DELETE PROTECTED ${p}` : `DELETE ${p}`;
    if (String(b.confirm || '') !== need) throw new Error(`To confirm, type exactly: ${need}`);
    const before = await val(p);
    if (before === null || before === undefined) throw new Error('Nothing is stored at that path.');
    await trashPut(actor, p, 'set', before, reason);
    await db.ref(p).remove();
    await writeAudit(actor, 'data_delete', 'data', p, reason, { children: countOf(before) }, null);
    return { path: p, deleted: true };
  });

  route('/api/admin/data/create', async (req, b) => {
    const actor = await requireAdmin(req, 'super');
    const p = checkDataPath(b.path);
    const reason = requireReason(b.reason);
    let value;
    try { value = JSON.parse(String(b.value ?? '')); }
    catch (e) { throw new Error('The value must be valid JSON, for example {"name":"test"}, "hello" or 1.'); }
    if (value === null) throw new Error('Use Delete to remove data. The value cannot be null.');
    const existing = await val(p);
    if (existing !== null && existing !== undefined && String(b.confirm || '') !== 'OVERWRITE') {
      throw new Error('Something is already stored there. To replace it, type OVERWRITE.');
    }
    await db.ref(p).set(value);
    await writeAudit(actor, existing !== null && existing !== undefined ? 'data_replace' : 'data_create', 'data', p, reason,
      existing !== null && existing !== undefined ? { children: countOf(existing) } : null, { children: countOf(value) });
    return { path: p, saved: true };
  });

  // ---------- Trash: list, restore, purge (super admin only, logged)
  route('/api/admin/data/trash', async (req, b) => {
    await requireAdmin(req, 'super');
    const snap = await db.ref('dataTrash').orderByChild('deletedAt').limitToLast(80).once('value');
    const items = Object.entries(snap.val() || {}).map(([id, x]) => ({
      id, path: x.path, mode: x.mode, deletedAt: x.deletedAt || 0, deletedByName: x.deletedByName || '',
      reason: x.reason || '', children: countOf(x.value), restoredAt: x.restoredAt || null, purgedAt: x.purgedAt || null
    })).sort((a, b2) => b2.deletedAt - a.deletedAt);
    return { items };
  });

  route('/api/admin/data/restore', async (req, b) => {
    const actor = await requireAdmin(req, 'super');
    const id = safeId(b.id, 'trash item');
    const reason = requireReason(b.reason);
    if (String(b.confirm || '') !== 'RESTORE') throw new Error('To confirm, type RESTORE.');
    const item = await val(`dataTrash/${id}`);
    if (!item) throw new Error('This item is not in the trash.');
    if (item.restoredAt || item.purgedAt) throw new Error('This item was already restored or removed.');

    if (item.mode === 'merge') {
      await db.ref(item.path).update(item.value || {});
    } else {
      const current = await val(item.path);
      if (current !== null && current !== undefined && String(b.overwrite || '') !== 'OVERWRITE') {
        throw new Error('Something is already stored there now. To replace it with the deleted data, type OVERWRITE.');
      }
      await db.ref(item.path).set(item.value);
    }
    await db.ref(`dataTrash/${id}`).update({ restoredAt: Date.now(), restoredBy: actor.uid });
    await writeAudit(actor, 'data_restore', 'data', item.path, reason, null, { trashId: id });
    return { path: item.path, restored: true };
  });

  route('/api/admin/data/purge', async (req, b) => {
    const actor = await requireAdmin(req, 'super');
    const id = safeId(b.id, 'trash item');
    const reason = requireReason(b.reason);
    if (String(b.confirm || '') !== 'PURGE') throw new Error('To confirm, type PURGE.');
    const item = await val(`dataTrash/${id}`);
    if (!item) throw new Error('This item is not in the trash.');
    await db.ref(`dataTrash/${id}`).remove();
    await writeAudit(actor, 'data_purge', 'data', item.path, reason, { trashId: id }, null);
    return { purged: true };
  });

  route('/api/admin/user/verify', async (req, b) => {
    const actor = await requireAdmin(req, 'verification');

    const uid = safeId(b.uid, 'user ID');
    const verified = b.verified === true;
    const reason = requireReason(b.reason);

    const u = await val(`users/${uid}`);

    if (!u) {
      throw new Error('User not found.');
    }

    const before = {
      verified: u.verified === true,
      kycStatus: u.kycStatus || ''
    };

    const now = Date.now();

    const patch = verified
      ? {
          verified: true,
          kycStatus: 'approved',
          sellerVerified: true,
          verifiedAt: now,
          verifiedBy: actor.uid,
          kycRevokedAt: null,
          kycRevokedBy: null,
          kycRevocationReason: null
        }
      : {
          verified: false,
          kycStatus: 'revoked',
          sellerVerified: false,
          kycRevokedAt: now,
          kycRevokedBy: actor.uid,
          kycRevocationReason: reason
        };

    await db.ref(`users/${uid}`).update(patch);

    await db.ref(`notifications/${uid}`).push({
      type: 'verification',
      message: verified
        ? 'Your MudyHub account is now verified.'
        : 'Your account verification was removed. Contact support if you think this is a mistake.',
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      verified ? 'verify_user' : 'unverify_user',
      'user',
      uid,
      reason,
      before,
      { verified }
    );

    return { verified };
  });

  // ------------------------------------------------------------
  // UNFREEZE USER WALLET
  // ------------------------------------------------------------

  route('/api/admin/user/unfreeze', async (req, b) => {
    const actor = await requireAdmin(req, 'withdrawals');

    const uid = safeId(b.uid, 'user ID');
    const reason = requireReason(b.reason);

    const u = await val(`users/${uid}`);

    if (!u) {
      throw new Error('User not found.');
    }

    if (u.walletFrozen !== true) {
      throw new Error('This wallet is not frozen.');
    }

    const now = Date.now();

    await db.ref(`users/${uid}`).update({
      walletFrozen: false,
      walletUnfrozenAt: now,
      walletUnfrozenBy: actor.uid,
      walletFreezeReason: null
    });

    await db.ref(`notifications/${uid}`).push({
      type: 'wallet',
      message: 'The security hold on your wallet has been lifted.',
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      'unfreeze_wallet',
      'user',
      uid,
      reason,
      { walletFrozen: true },
      { walletFrozen: false }
    );

    return {};
  });

  // ------------------------------------------------------------
  // KYC APPLICATION LIST
  // IMPORTANT: Never return NIN in the list response.
  // ------------------------------------------------------------

  route('/api/admin/kyc/list', async req => {
    await requireAdmin(req, 'verification');

    const s = await db
      .ref('super_admin_kyc')
      .orderByChild('status')
      .equalTo('pending')
      .limitToFirst(60)
      .once('value');

    const items = Object.entries(s.val() || {})
      .map(([id, k]) => ({
        id,
        uid: k.uid,
        fullName: clean(k.fullName, 100),
        phone: clean(k.phone, 30),
        feePaid: Number(k.feePaid || 0),
        submittedAt: k.submittedAt || 0,
        hasId: !!k.idImage,
        hasSelfie: !!k.selfieImage
      }))
      .sort((a, b) => a.submittedAt - b.submittedAt);

    return { items };
  });

  // ------------------------------------------------------------
  // GET ONE KYC APPLICATION
  // Restricted individual review endpoint.
  // Access is recorded in the audit log.
  // ------------------------------------------------------------

  route('/api/admin/kyc/get', async (req, b) => {
    const actor = await requireAdmin(req, 'verification');

    const id = safeId(b.id, 'application ID');
    const k = await val(`super_admin_kyc/${id}`);

    if (!k) {
      throw new Error('Application not found.');
    }

    await writeAudit(
      actor,
      'view_kyc_application',
      'kyc',
      id,
      'Restricted identity application accessed for manual review.',
      null,
      { viewed: true }
    );

    return {
      item: {
        id,
        uid: k.uid,
        fullName: k.fullName || '',
        phone: k.phone || '',
        address: k.address || '',
        nin: k.nin || '',
        feePaid: Number(k.feePaid || 0),
        status: k.status,
        submittedAt: k.submittedAt,
        idImage: k.idImage || '',
        selfieImage: k.selfieImage || '',
        guarantor: k.guarantor || null
      }
    };
  });

  // ------------------------------------------------------------
  // REVIEW KYC APPLICATION
  // Rejection refunds are protected against duplicate credit.
  // ------------------------------------------------------------

  route('/api/admin/kyc/review', async (req, b) => {
    const actor = await requireAdmin(req, 'verification');

    const id = safeId(b.id, 'application ID');
    const decision = b.decision;

    if (!['approve', 'reject'].includes(decision)) {
      throw new Error('Invalid decision.');
    }

    const reason = clean(b.reason, 500);

    if (decision === 'reject' && reason.length < 5) {
      throw new Error(
        'A rejection reason is required (it is shown to the user).'
      );
    }

    const kycRef = db.ref(`super_admin_kyc/${id}`);
    const k = await val(`super_admin_kyc/${id}`);

    if (!k) {
      throw new Error('Application not found.');
    }

    const uid = String(k.uid || '');

    if (!uid) {
      throw new Error('Application has no user.');
    }

    const claim = await kycRef
      .child('status')
      .transaction(cur =>
        cur === 'pending' ? 'reviewing' : undefined
      );

    if (!claim.committed) {
      throw new Error(
        'This application was already reviewed.'
      );
    }

    const now = Date.now();

    try {
      if (decision === 'approve') {
        await db.ref(`users/${uid}`).update({
          verified: true,
          kycStatus: 'approved',
          sellerVerified: true,
          verifiedAt: now,
          verifiedBy: actor.uid
        });

        await kycRef.update({
          status: 'approved',
          reviewedAt: now,
          reviewedBy: actor.uid
        });

        await db.ref(`notifications/${uid}`).push({
          type: 'verification',
          message: 'Your MudyHub verification was approved.',
          createdAt: now,
          read: false
        });

        await writeAudit(
          actor,
          'approve_verification',
          'kyc',
          id,
          reason,
          { status: 'pending' },
          { status: 'approved', uid }
        );

        return { status: 'approved' };
      }

      const fee = Math.max(
        0,
        Number(k.feePaid || 0)
      );

      let refunded = 0;

      if (fee > 0) {
        await creditOnce(
          uid,
          `kyc_${id}`,
          fee
        );

        refunded = fee;

        await db
          .ref(`walletLedger/${uid}/kyc_refund_${id}`)
          .set({
            type: 'verification_refund',
            direction: 'credit',
            amount: fee,
            reference: id,
            description:
              'Refund for rejected verification',
            status: 'completed',
            createdAt: now,
            adminUid: actor.uid
          });
      }

      await db.ref(`users/${uid}`).update({
        kycStatus: 'rejected'
      });

      await kycRef.update({
        status: 'rejected',
        rejectionReason: reason,
        reviewedAt: now,
        reviewedBy: actor.uid,
        refundedAmount: refunded
      });

      await db.ref(`notifications/${uid}`).push({
        type: 'verification',
        message:
          `Your verification was rejected. Reason: ${reason}.${refunded ? ' The fee was refunded to your wallet.' : ''}`,
        createdAt: now,
        read: false
      });

      await writeAudit(
        actor,
        'reject_verification',
        'kyc',
        id,
        reason,
        { status: 'pending' },
        { status: 'rejected', refunded }
      );

      return {
        status: 'rejected',
        refunded
      };
    } catch (e) {
      await kycRef
        .child('status')
        .transaction(cur =>
          cur === 'reviewing' ? 'pending' : undefined
        )
        .catch(() => {});

      throw e;
    }
  });

  // ------------------------------------------------------------
  // CONTENT MODERATION — POSTS, STATUSES AND JOBS
  // ------------------------------------------------------------

  route('/api/admin/moderation/remove', async (req, b) => {
    const actor = await requireAdmin(req, 'moderation');

    const kind = b.kind;
    const id = safeId(b.id);
    const reason = requireReason(b.reason);

    if (!['post', 'status', 'job'].includes(kind)) {
      throw new Error('Unsupported content type.');
    }

    const now = Date.now();

    if (kind === 'job') {
      const job = await val(`jobs/${id}`);

      if (!job) {
        throw new Error('Job not found.');
      }

      if (
        ['in_progress', 'completed_by_worker']
          .includes(job.status)
      ) {
        throw new Error(
          'This job has an active worker. Resolve it through Support first.'
        );
      }

      await db.ref(`jobs/${id}`).update({
        status: 'removed_by_admin',
        moderationReason: reason,
        moderatedBy: actor.uid,
        moderatedAt: now
      });

      if (job.posterId) {
        await db.ref(`notifications/${job.posterId}`).push({
          type: 'moderation',
          message:
            `Your job "${clean(job.title, 60)}" was removed by MudyHub moderation. Reason: ${reason}`,
          createdAt: now,
          read: false
        });
      }

      await writeAudit(
        actor,
        'remove_job',
        'job',
        id,
        reason,
        { status: job.status },
        { status: 'removed_by_admin' }
      );

      return {};
    }

    const node =
      kind === 'post' ? 'posts' : 'statuses';

    const item = await val(`${node}/${id}`);

    if (!item) {
      throw new Error(
        'Content not found (it may already be removed).'
      );
    }

    await db
      .ref(`moderatedContent/${kind}/${id}`)
      .set({
        content: item,
        reason,
        removedBy: actor.uid,
        removedAt: now
      });

    await db.ref(`${node}/${id}`).remove();

    const authorId =
      item.userId || item.uid || '';

    if (authorId) {
      await db.ref(`notifications/${authorId}`).push({
        type: 'moderation',
        message:
          `One of your ${kind === 'post' ? 'posts' : 'status updates'} was removed for breaking community rules. Reason: ${reason}`,
        createdAt: now,
        read: false
      });
    }

    await writeAudit(
      actor,
      `remove_${kind}`,
      kind,
      id,
      reason,
      { author: authorId },
      { removed: true }
    );

    return {};
  });

  // ------------------------------------------------------------
  // FINANCE — CONFIRM MANUAL BANK PAYOUT
  // Only call after the actual bank transfer is completed.
  // ------------------------------------------------------------

  route('/api/admin/withdrawal/mark-paid', async (req, b) => {
    const actor = await requireAdmin(req, 'withdrawals');

    const id = safeId(b.id, 'withdrawal ID');
    const reference = clean(b.reference, 80);

    if (!/^[A-Za-z0-9][A-Za-z0-9\-_\/]{4,79}$/.test(reference)) {
      throw new Error(
        'Enter the bank transfer reference from your receipt (at least 5 letters or numbers) before marking this as paid.'
      );
    }

    const wRef = db.ref(`withdrawalRequests/${id}`);
    const initial = await val(`withdrawalRequests/${id}`);

    if (!initial) {
      throw new Error('Withdrawal not found.');
    }

    const uid = String(
      initial.uid || initial.userId || ''
    );

    const amount = Number(initial.amount || 0);

    if (
      !uid ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      throw new Error(
        'Withdrawal record is incomplete.'
      );
    }

    if (initial.status === 'paid') {
      if (initial.payoutReference !== reference) {
        throw new Error(
          'This withdrawal has already been paid with a different reference.'
        );
      }

      return {
        status: 'paid',
        alreadyPaid: true
      };
    }

    const now0 = Date.now();
    const claim = await wRef.transaction(current => {
      // Firebase can call this with null before it has the stored value. Use the record we already read.
      const base = current === null ? initial : current;
      if (!base) return;

      if (base.status === 'approved') {
        return {
          ...base,
          status: 'paying',
          payoutStatus: 'confirming',
          payoutReference: reference,
          payingAt: now0,
          payingBy: actor.uid
        };
      }

      if (base.status === 'paying' && actor.role === 'super_admin' &&
          (base.payoutReference === reference || b.resumeStuck === true)) {
        return {
          ...base,
          payoutReference: reference,
          payingBy: actor.uid,
          payingAt: now0,
          resumedFrom: base.payoutReference || null,
          lastPaymentRetryAt: now0
        };
      }

      if (base.status === 'paying' && base.payoutReference === reference &&
          (base.payingBy === actor.uid || actor.role === 'super_admin')) {
        return { ...base, payingBy: actor.uid, lastPaymentRetryAt: now0 };
      }

      return;   // not in a payable state: the transaction is refused and we explain why below
    });

    if (!claim.committed) {
      const now1 = await val(`withdrawalRequests/${id}`);
      if (now1 && now1.status === 'paid') {
        throw new Error('This withdrawal is already marked as paid.');
      }
      if (now1 && now1.status === 'paying' && now1.payoutReference !== reference) {
        throw new Error(
          `A previous payout attempt is recorded with reference "${now1.payoutReference}". If that transfer was made, enter that same reference. To replace it, confirm "Resume stuck payout".`
        );
      }
      if (now1 && now1.status && now1.status !== 'approved' && now1.status !== 'paying') {
        throw new Error(`This withdrawal is "${now1.status}", so it cannot be marked as paid.`);
      }
      throw new Error('This withdrawal could not be updated. Refresh the page and try again.');
    }

    const w = claim.snapshot.val();
    const now = Date.now();

    if (w.ledgerId) {
      await db
        .ref(`walletLedger/${uid}/${w.ledgerId}`)
        .update({
          status: 'paid',
          paidAt: now,
          payoutReference: reference
        });
    }

    await db.ref(`withdrawalPayouts/${id}`).set({
      withdrawalId: id,
      uid,
      amount,
      status: 'paid',
      bankReference: reference,
      confirmedBy: actor.uid,
      confirmedAt: now,
      ledgerId: w.ledgerId || null
    });

    await db
      .ref(`notifications/${uid}/withdrawal_paid_${id}`)
      .set({
        type: 'withdrawal_paid',
        amount,
        message:
          `Your withdrawal of ₦${amount.toLocaleString()} has been paid to your bank account.`,
        reference,
        createdAt: now,
        read: false
      });

    await writeAudit(
      actor,
      'mark_withdrawal_paid',
      'withdrawal',
      id,
      w.resumedFrom
        ? `Stuck payout resumed by super admin. Earlier attempt reference: ${w.resumedFrom}. Confirmed reference: ${reference}`
        : `Manual bank payout confirmed. Reference: ${reference}`,
      { status: 'approved' },
      {
        status: 'paid',
        payoutReference: reference,
        amount
      }
    );

    await wRef.update({
      status: 'paid',
      payoutStatus: 'paid',
      paidAt: now,
      paidBy: actor.uid,
      payoutReference: reference,
      payoutNotice:
        'Manual bank payout completed and confirmed.'
    });

    return {
      status: 'paid',
      amount,
      reference,
      message:
        'Withdrawal payment confirmed successfully.'
    };
  });

  // ------------------------------------------------------------
  // TRUE CONNECTION — LIST SUSPENDED MEMBERS
  // ------------------------------------------------------------

  route('/api/admin/tc/suspended', async req => {
    await requireAdmin(req, 'tc:moderate');

    const snap = await db
      .ref('trueConnectionEligibility')
      .orderByChild('suspended')
      .equalTo(true)
      .limitToFirst(100)
      .once('value');

    const out = [];

    for (const uid of Object.keys(snap.val() || {})) {
      const u = await val(`users/${uid}`) || {};

      out.push({
        uid,
        fullName: clean(
          u.fullName || u.name,
          80
        ),
        username: clean(u.username, 40),
        verified: u.verified === true
      });
    }

    return { members: out };
  });

  // ------------------------------------------------------------
  // TRUE CONNECTION — RESTORE MEMBER
  // Restore the profile's previous active state.
  // Do not automatically activate a profile that was inactive.
  // ------------------------------------------------------------

  route('/api/admin/tc/restore', async (req, b) => {
    const actor = await requireAdmin(req, 'tc:moderate');

    const uid = safeId(b.uid, 'user ID');
    const reason = requireReason(b.reason);

    const el = await val(
      `trueConnectionEligibility/${uid}`
    );

    if (!el || el.suspended !== true) {
      throw new Error(
        'This member is not suspended.'
      );
    }

    const previousActive =
      el.suspendedPreviousActive === true;

    const now = Date.now();

    await db.ref().update({
      [`trueConnectionEligibility/${uid}/suspended`]: false,
      [`trueConnectionEligibility/${uid}/suspendedPreviousActive`]: null,
      [`trueConnectionEligibility/${uid}/restoredAt`]: now,
      [`trueConnectionEligibility/${uid}/restoredBy`]: actor.uid,
      [`trueConnectionProfiles/${uid}/active`]: previousActive
    });

    await db.ref(`notifications/${uid}`).push({
      type: 'true_connection',
      message:
        'Your True Connection access has been restored.',
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      'tc_restore_member',
      'user',
      uid,
      reason,
      { suspended: true },
      {
        suspended: false,
        profileActive: previousActive
      }
    );

    return {
      restored: true,
      profileActive: previousActive
    };
  });

  // ------------------------------------------------------------
  // WITHDRAWAL — EARNINGS AUDIT
  // ------------------------------------------------------------

  route('/api/admin/withdrawal/audit', async (req, b) => {
    await requireAdmin(req, 'withdrawals');

    const id = safeId(b.id, 'withdrawal ID');

    const w = await val(`withdrawalRequests/${id}`);

    if (!w) {
      throw new Error('Withdrawal not found.');
    }

    const uid = String(
      w.uid || w.userId || ''
    );

    if (!uid) {
      throw new Error(
        'Withdrawal record is incomplete.'
      );
    }

    const [tops, subs, legacy, wds] =
      await Promise.all([
        val(`walletTopups/${uid}`),

        db.ref('submissions')
          .orderByChild('userId')
          .equalTo(uid)
          .once('value')
          .then(s => s.val()),

        db.ref('taskSubmissions')
          .orderByChild('uid')
          .equalTo(uid)
          .once('value')
          .then(s => s.val())
          .catch(() => null),

        db.ref('withdrawalRequests')
          .orderByChild('uid')
          .equalTo(uid)
          .once('value')
          .then(s => s.val())
      ]);

    let totalToppedUp = 0;
    let totalEarned = 0;
    let totalWithdrawn = 0;
    let pendingOther = 0;

    Object.values(tops || {}).forEach(t => {
      if (t && t.status === 'completed') {
        totalToppedUp += Number(t.amount || 0);
      }
    });

    Object.values(subs || {}).forEach(x => {
      if (x && x.status === 'approved') {
        totalEarned += Number(
          x.netCredited != null
            ? x.netCredited
            : Number(x.rewardAmount || 0) * 0.8
        );
      }
    });

    Object.values(legacy || {}).forEach(x => {
      if (x && x.status === 'approved') {
        totalEarned += Number(
          x.rewardAmount || x.amount || 0
        );
      }
    });

    Object.values(wds || {}).forEach(x => {
      const amt = Number(
        x && x.amount || 0
      );

      if (
        x &&
        (
          x.status === 'approved' ||
          x.status === 'paid'
        )
      ) {
        totalWithdrawn += amt;
      } else if (
        x &&
        (
          x.status === 'pending' ||
          x.status === 'processing'
        )
      ) {
        pendingOther += amt;
      }
    });

    pendingOther = Math.max(
      0,
      pendingOther - Number(w.amount || 0)
    );

    const expected =
      totalToppedUp +
      totalEarned -
      totalWithdrawn -
      pendingOther;

    const actual = Number(
      w.balanceBefore || 0
    );

    const mismatch = actual - expected;

    const r2 = n =>
      Math.round(n * 100) / 100;

    return {
      audit: {
        totalToppedUp: r2(totalToppedUp),
        totalEarned: r2(totalEarned),
        totalWithdrawn: r2(totalWithdrawn),
        totalPendingOther: r2(pendingOther),
        expectedBalanceBefore: r2(expected),
        actualBalanceBefore: r2(actual),
        mismatch: r2(mismatch),
        isFraud: Math.abs(mismatch) > 5
      }
    };
  });

  // ------------------------------------------------------------
  // BUSINESS / COMPANY APPLICATION LIST
  // Return only approved display fields.
  // Never return arbitrary database fields or base64 images.
  // ------------------------------------------------------------

  route('/api/admin/company/list', async req => {
    await requireAdmin(req, 'business');

    const all = (await val('companies')) || {};

    const allowedFields = [
      'businessName',
      'companyName',
      'name',
      'ownerName',
      'fullName',
      'email',
      'phone',
      'address',
      'businessAddress',
      'category',
      'businessType',
      'description',
      'cacNumber',
      'registrationNumber',
      'cacStatus',
      'cacDocumentUrl',
      'certificateUrl',
      'documentUrl',
      'logoUrl',
      'website',
      'submittedAt',
      'createdAt'
    ];

    const items = Object.entries(all)
      .filter(([, c]) =>
        c && typeof c === 'object'
      )
      .slice(-300)
      .map(([uid, c]) => {
        const out = {
          uid,
          status: clean(
            c.status || 'pending',
            30
          )
        };

        for (const key of allowedFields) {
          const value = c[key];

          if (typeof value === 'string') {
            if (
              value.length <= 2000 &&
              !/^data:image\//i.test(value) &&
              !/^data:application\//i.test(value)
            ) {
              out[key] = clean(value, 500);
            }
          } else if (
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            out[key] = value;
          }
        }

        return out;
      });

    return { items };
  });

  // ------------------------------------------------------------
  // BUSINESS / COMPANY APPLICATION REVIEW
  // ------------------------------------------------------------

  route('/api/admin/company/review', async (req, b) => {
    const actor = await requireAdmin(req, 'business');

    const uid = safeId(b.uid, 'company ID');
    const decision = b.decision;

    if (
      ![
        'approve',
        'reject',
        'suspend',
        'reinstate'
      ].includes(decision)
    ) {
      throw new Error('Invalid decision.');
    }

    const reason =
      decision === 'approve' ||
      decision === 'reinstate'
        ? clean(b.reason, 500)
        : requireReason(b.reason, 5);

    const c = await val(`companies/${uid}`);

    if (!c) {
      throw new Error('Company not found.');
    }

    const next = {
      approve: 'verified',
      reinstate: 'verified',
      reject: 'rejected',
      suspend: 'suspended'
    }[decision];

    const now = Date.now();

    await db.ref(`companies/${uid}`).update({
      status: next,
      reviewedAt: now,
      reviewedBy: actor.uid,
      reviewReason: reason
    });

    const msg = {
      verified:
        'Your business has been verified on MudyHub.',
      rejected:
        `Your business application was not approved. Reason: ${reason}`,
      suspended:
        `Your business verification was suspended. Reason: ${reason}`
    }[next];

    await db.ref(`notifications/${uid}`).push({
      type: 'business',
      message: msg,
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      `company_${decision}`,
      'company',
      uid,
      reason,
      { status: c.status || 'pending' },
      { status: next }
    );

    return { status: next };
  });

  // ------------------------------------------------------------
  // TRUE CONNECTION — APPLICATION LIST
  // ------------------------------------------------------------

  route('/api/admin/tc/applications', async (req, b) => {
    await requireAdmin(req, 'tc:moderate');

    const status = [
      'pending',
      'approved',
      'rejected'
    ].includes(b.status)
      ? b.status
      : 'pending';

    const snap = await db
      .ref('trueConnectionEligibility')
      .orderByChild('approval')
      .equalTo(status)
      .limitToFirst(100)
      .once('value');

    const items = [];

    for (const [uid, e] of Object.entries(
      snap.val() || {}
    )) {
      const [u, p] = await Promise.all([
        val(`users/${uid}`),
        val(`trueConnectionProfiles/${uid}`)
      ]);

      const user = u || {};

      const safeProfile = p
        ? Object.fromEntries(
            Object.entries(p)
              .filter(([, v]) =>
                typeof v === 'string' ||
                typeof v === 'number' ||
                (
                  Array.isArray(v) &&
                  v.every(x => typeof x === 'string')
                )
              )
              .map(([k, v]) => [
                k,
                Array.isArray(v)
                  ? v
                      .map(x => clean(x, 60))
                      .slice(0, 20)
                  : typeof v === 'string'
                    ? clean(v, 400)
                    : v
              ])
          )
        : null;

      items.push({
        uid,

        fullName: clean(
          user.fullName || user.name,
          80
        ),

        username: clean(
          user.username,
          40
        ),

        email: clean(
          user.email,
          120
        ),

        verified:
          user.verified === true ||
          user.kycStatus === 'approved',

        banned: user.banned === true,

        ageBand: e.ageBand,

        appliedAt:
          e.appliedAt ||
          e.rulesAcceptedAt ||
          0,

        reviewedAt: e.reviewedAt || 0,

        rejectionReason: clean(
          e.rejectionReason,
          200
        ),

        profile: safeProfile
      });
    }

    return { items };
  });

  // ------------------------------------------------------------
  // TRUE CONNECTION — APPROVE OR REJECT APPLICATION
  // ------------------------------------------------------------

  route('/api/admin/tc/review', async (req, b) => {
    const actor = await requireAdmin(req, 'tc:moderate');

    const uid = safeId(b.uid, 'user ID');
    const decision = b.decision;

    if (!['approve', 'reject'].includes(decision)) {
      throw new Error('Invalid decision.');
    }

    const reason =
      decision === 'approve'
        ? clean(b.reason, 500)
        : requireReason(b.reason, 5);

    const e = await val(
      `trueConnectionEligibility/${uid}`
    );

    if (!e) {
      throw new Error('Application not found.');
    }

    if (e.approval !== 'pending') {
      throw new Error(
        'This application was already reviewed.'
      );
    }

    const user =
      await val(`users/${uid}`) || {};

    if (decision === 'approve') {
      if (
        user.banned === true ||
        user.status === 'banned'
      ) {
        throw new Error(
          'This account is banned.'
        );
      }

      if (
        !(
          user.verified === true ||
          user.kycStatus === 'approved' ||
          user.kycStatus === 'verified'
        )
      ) {
        throw new Error(
          'Verify this member first (Verification), then approve.'
        );
      }
    }

    const now = Date.now();

    await db
      .ref(`trueConnectionEligibility/${uid}`)
      .update(
        decision === 'approve'
          ? {
              eligible: true,
              approval: 'approved',
              reviewedAt: now,
              reviewedBy: actor.uid
            }
          : {
              eligible: false,
              approval: 'rejected',
              reviewedAt: now,
              reviewedBy: actor.uid,
              rejectionReason: reason
            }
      );

    await db.ref(`notifications/${uid}`).push({
      type: 'true_connection',
      message:
        decision === 'approve'
          ? 'You have been approved for True Connection. Welcome!'
          : `Your True Connection application was not approved. Reason: ${reason}`,
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      `tc_application_${decision}`,
      'user',
      uid,
      reason,
      { approval: 'pending' },
      {
        approval:
          decision === 'approve'
            ? 'approved'
            : 'rejected'
      }
    );

    return {};
  });

  // ------------------------------------------------------------
  // TRUE CONNECTION — SUSPEND MEMBER
  // Save the profile's previous active state.
  // Do not overwrite it if the member is already suspended.
  // ------------------------------------------------------------

  route('/api/admin/tc/suspend', async (req, b) => {
    const actor = await requireAdmin(req, 'tc:moderate');

    const uid = safeId(b.uid, 'user ID');
    const reason = requireReason(b.reason);

    const eligibilityRef =
      db.ref(`trueConnectionEligibility/${uid}`);

    const e = await val(
      `trueConnectionEligibility/${uid}`
    );

    if (!e) {
      throw new Error(
        'This member has no True Connection account.'
      );
    }

    if (e.suspended === true) {
      throw new Error(
        'This member is already suspended.'
      );
    }

    const profile = await val(
      `trueConnectionProfiles/${uid}`
    );

    const previousActive =
      !!(profile && profile.active === true);

    const now = Date.now();

    await db.ref().update({
      [`trueConnectionEligibility/${uid}/suspended`]: true,
      [`trueConnectionEligibility/${uid}/suspendedPreviousActive`]: previousActive,
      [`trueConnectionEligibility/${uid}/suspendedAt`]: now,
      [`trueConnectionEligibility/${uid}/suspendedBy`]: actor.uid,
      [`trueConnectionProfiles/${uid}/active`]: false,
      [`trueConnectionRecommendations/${uid}`]: null
    });

    await db.ref(`notifications/${uid}`).push({
      type: 'true_connection',
      message:
        'Your True Connection access has been suspended by MudyHub safety staff.',
      createdAt: now,
      read: false
    });

    await writeAudit(
      actor,
      'tc_suspend_member',
      'user',
      uid,
      reason,
      {
        suspended: false,
        profileActive: previousActive
      },
      {
        suspended: true,
        profileActive: false
      }
    );

    return {
      suspended: true
    };
  });
}
