// MudyHub V1 — Earning Hub task submissions, handled on the server.
// Registered from server.js:  registerTasks({ app, admin, db, authenticatedUid });
//
//   POST /api/tasks/submit  { campaignId, proofImage (data URI), proofNotes }
//
// The server (not the browser) now:
//   - allows ONE live submission per user per task (a rejected one frees the user to try again),
//   - reserves a slot immediately, so slots go down the moment someone submits,
//   - refuses submissions once every slot is taken,
//   - reads the reward from the task record, never from the browser.
// Rejecting a submission (server.js /api/admin/task/review) gives the slot back.

export default function registerTasks({ app, admin, db, authenticatedUid }) {
  const NODES = { campaigns: 'completedSlots', adminCreatedTasks: 'completedSlots', adminAds: 'viewsCompleted' };
  const SAFE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
  const IMG = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
  const MAX_IMG_CHARS = 900000;     // ~650 KB of image data
  const fail = (status, message) => Object.assign(new Error(message), { status });

  app.post('/api/tasks/submit', async (req, res) => {
    let uid = null, claimRef = null, claimed = false, reserved = false, counterRef = null;
    try {
      uid = await authenticatedUid(req);
      const b = req.body || {};
      const campaignId = String(b.campaignId || '').trim();
      if (!SAFE_KEY.test(campaignId)) throw fail(400, 'Invalid task.');
      const proofImage = String(b.proofImage || '');
      if (!IMG.test(proofImage) || proofImage.length > MAX_IMG_CHARS) throw fail(400, 'Attach a PNG, JPG or WebP screenshot under 500KB.');
      const proofNotes = String(b.proofNotes || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000);

      const authUser = await admin.auth().getUser(uid);
      if (!authUser.emailVerified) throw fail(403, 'Verify your email address before submitting tasks.');
      const user = (await db.ref(`users/${uid}`).once('value')).val();
      if (!user) throw fail(404, 'User not found.');
      if (user.banned === true || user.status === 'banned' || user.walletFrozen === true) throw fail(403, 'Your account is restricted.');

      // Find the task.
      let node = null, task = null;
      for (const n of Object.keys(NODES)) {
        const v = (await db.ref(`${n}/${campaignId}`).once('value')).val();
        if (v) { node = n; task = v; break; }
      }
      if (!task) throw fail(404, 'Task not found.');
      if (task.status !== 'active') throw fail(400, 'This task is not active.');
      if (task.creatorId && task.creatorId === uid) throw fail(403, 'You cannot complete your own task.');
      const reward = Number(task.reward ?? task.rewardPerAction ?? task.rewardPerView ?? 0);
      if (!Number.isFinite(reward) || reward <= 0) throw fail(400, 'This task has no valid reward.');
      const totalSlots = Number(task.totalSlots || 0);   // 0 / missing = unlimited (admin tasks)
      const counterField = NODES[node];

      // 1) One live submission per user per task.
      claimRef = db.ref(`taskClaims/${campaignId}/${uid}`);
      const claim = await claimRef.transaction(cur => cur ? undefined : { at: Date.now() });
      if (!claim.committed) throw fail(409, 'You already submitted proof for this task.');
      claimed = true;

      // 2) Reserve a slot (never past the limit).
      counterRef = db.ref(`${node}/${campaignId}/${counterField}`);
      let full = false;
      const slot = await counterRef.transaction(cur => {
        full = false;
        const n = Number(cur || 0);
        if (totalSlots > 0 && n >= totalSlots) { full = true; return; }
        return n + 1;
      });
      if (!slot.committed || full) throw fail(409, 'All slots for this task are filled.');
      reserved = true;

      // 3) Save the submission (server-written, so no one can fake status or reward).
      const subRef = db.ref('submissions').push();
      await subRef.set({
        campaignId, srcNode: node, userId: uid, slotReserved: true,
        rewardAmount: reward,
        campaignTitle: String(task.title || 'Task').slice(0, 120),
        campaignCategory: String(task.category || 'task').slice(0, 30),
        creatorId: task.creatorId || 'admin', creatorName: String(task.creatorName || 'MudyHub').slice(0, 80),
        proofImage, proofNotes, status: 'pending', submittedAt: Date.now()
      });
      await claimRef.update({ submissionId: subRef.key });
      return res.json({ ok: true, id: subRef.key, status: 'pending' });
    } catch (e) {
      try {
        if (reserved && counterRef) await counterRef.transaction(cur => Math.max(0, Number(cur || 0) - 1));
        if (claimed && claimRef) await claimRef.remove();
      } catch (re) { console.error('Task submit rollback failed:', re); }
      const status = e.status || (e.message === 'Unauthorized' ? 401 : 500);
      if (status === 500) console.error('Task submit error:', e);
      return res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
    }
  });
}
