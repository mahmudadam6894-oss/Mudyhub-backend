// MudyHub V1 — Business: company verification, paid graduate-job posting with admin approval, applications.
// Register from server.js:
//   registerBusiness({ app, admin, db, authenticatedUid, requireAdmin, writeAudit });
//
// Client endpoints
//   POST /api/business/register            { companyName, cacNumber, email, website }
//   POST /api/business/jobs/create         { requestId, title, jobType, salary, location, description }
//   POST /api/business/jobs/apply          { jobId, message, link }
// Admin endpoints
//   POST /api/business/admin/company/review  { uid, decision: 'verify'|'reject', reason }
//   POST /api/business/admin/job/review      { jobId, decision: 'approve'|'reject', reason }
//
// Money rules: the posting fee is taken on the server when the job is submitted. It is kept when the job
// is approved, and refunded exactly once if the job is rejected or publication fails.
// Jobs stay "pending_review" until an admin approves them. Applicants are stored in jobApplicants, not
// inside the job, so private details are never visible to other users.

export default function registerBusiness({ app, admin, db, authenticatedUid, requireAdmin, writeAudit }) {
  const FEE = 5000;
  const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const reply = (res, e) => {
    const status = e.status || (e.message === 'Unauthorized' ? 401 : e.message === 'Forbidden' ? 403 : 500);
    if (status === 500) console.error('[business]', e);
    return res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
  };

  // Same KYC rule as the marketplace seller verification.
  async function verifiedUser(uid) {
    const authUser = await admin.auth().getUser(uid);
    if (!authUser.emailVerified) throw fail(403, 'Verify your email address first.');
    const snap = await db.ref(`users/${uid}`).once('value');
    const u = snap.val();
    if (!u) throw fail(404, 'User account not found.');
    if (u.banned === true || u.status === 'banned' || u.walletFrozen === true) throw fail(403, 'Your account or wallet is restricted.');
    if (u.sellerVerified !== true || (u.sellerExpiry && Number(u.sellerExpiry) < Date.now())) throw fail(403, 'Complete valid KYC verification first.');
    return u;
  }

  async function refundOnce(uid, amount, claimKey, note) {
    const r = await db.ref(`users/${uid}`).transaction(u => {
      if (!u) return u;
      const keys = u.businessFeeRefundClaims || {};
      if (keys[claimKey]) return u;                       // already refunded: no change
      u.walletBalance = Number(u.walletBalance || 0) + amount;
      keys[claimKey] = { amount, at: Date.now() };
      u.businessFeeRefundClaims = keys;
      return u;
    });
    if (r.committed && (await db.ref(`users/${uid}/businessFeeRefundClaims/${claimKey}`).once('value')).exists()) {
      await db.ref(`walletLedger/${uid}/business_refund_${claimKey}`).set({
        type: 'job_post_refund', direction: 'credit', amount, reference: claimKey, description: note, status: 'completed', createdAt: Date.now()
      });
    }
    return r.committed;
  }

  // ---------- company registration ----------
  app.post('/api/business/register', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const user = await verifiedUser(uid);
      const b = req.body || {};
      const companyName = clean(b.companyName, 120), cacNumber = clean(b.cacNumber, 60);
      const email = clean(b.email, 160).toLowerCase(), website = clean(b.website, 300);
      if (companyName.length < 2 || cacNumber.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw fail(400, 'Enter a valid company name, CAC number and official email.');
      }
      if (website && !/^https:\/\//i.test(website)) throw fail(400, 'Website must start with https://');
      const companyRef = db.ref(`companies/${uid}`);
      const old = (await companyRef.once('value')).val();
      if (old?.status === 'verified') throw fail(409, 'This company is already verified.');
      if (old?.status === 'pending') throw fail(409, 'Your company is already awaiting review.');
      await companyRef.set({
        uid, companyName, cacNumber, email, website, status: 'pending', createdAt: Date.now(),
        submittedBy: uid, submittedName: clean(user.fullName || user.username || 'MudyHub User', 80)
      });
      return res.json({ ok: true, status: 'pending' });
    } catch (e) { return reply(res, e); }
  });

  // ---------- post a graduate job (fee taken now, job published after admin approval) ----------
  app.post('/api/business/jobs/create', async (req, res) => {
    let uid = null, claimRef = null, debited = false, jobRef = null, requestId = '';
    try {
      uid = await authenticatedUid(req);
      await verifiedUser(uid);
      const company = (await db.ref(`companies/${uid}`).once('value')).val();
      if (!company || company.status !== 'verified') throw fail(403, 'Your company must be verified before posting jobs.');

      const b = req.body || {};
      const title = clean(b.title, 120), jobType = clean(b.jobType, 40), salary = clean(b.salary, 100);
      const location = clean(b.location, 120), description = clean(b.description, 3000);
      requestId = clean(b.requestId, 100);
      if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) throw fail(400, 'Invalid request ID.');
      if (title.length < 3 || !jobType || salary.length < 2 || location.length < 2 || description.length < 20) {
        throw fail(400, 'Complete all job details. Description must be at least 20 characters.');
      }

      claimRef = db.ref(`businessJobRequests/${uid}/${requestId}`);
      const claim = await claimRef.transaction(v => v ? undefined : { state: 'processing', fee: FEE, at: Date.now() });
      if (!claim.committed) throw fail(409, 'This posting request was already submitted.');

      const debit = await db.ref(`users/${uid}`).transaction(u => {
        if (!u) return u;
        const bal = Number(u.walletBalance || 0);
        if (!Number.isFinite(bal) || bal < FEE) return;
        const keys = u.businessFeeClaims || {};
        if (keys[requestId]) return;
        u.walletBalance = bal - FEE;
        keys[requestId] = { amount: FEE, at: Date.now() };
        u.businessFeeClaims = keys;
        return u;
      });
      if (!debit.committed) {
        await claimRef.remove().catch(() => {});
        throw fail(400, 'Insufficient wallet balance. Top up and try again.');
      }
      debited = true;

      const now = Date.now();
      jobRef = db.ref('graduateJobs').push();
      await jobRef.set({
        id: jobRef.key, companyId: uid, companyName: clean(company.companyName, 120),
        title, jobType, salary, location, description,
        status: 'pending_review', applicantCount: 0, postingFee: FEE, createdAt: now
      });
      await db.ref(`walletLedger/${uid}/business_job_fee_${requestId}`).set({
        type: 'job_post_fee', direction: 'debit', amount: FEE, reference: jobRef.key,
        description: `Graduate job posting (awaiting review): ${title}`, status: 'completed', createdAt: now
      });
      await claimRef.update({ state: 'submitted', jobId: jobRef.key, submittedAt: now });
      return res.json({ ok: true, jobId: jobRef.key, status: 'pending_review', fee: FEE });
    } catch (e) {
      try {
        if (debited && uid && requestId) {
          if (jobRef) await jobRef.remove().catch(() => {});
          const ok = await refundOnce(uid, FEE, requestId, 'Graduate job posting refund (not published)');
          if (ok && claimRef) await claimRef.update({ state: 'refunded', refundedAt: Date.now() }).catch(() => {});
        } else if (claimRef) {
          await claimRef.remove().catch(() => {});
        }
      } catch (re) { console.error('[business] posting refund failed', re); }
      return reply(res, e);
    }
  });

  // ---------- apply to a published job ----------
  app.post('/api/business/jobs/apply', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const user = await verifiedUser(uid);
      const b = req.body || {};
      const jobId = clean(b.jobId, 100), message = clean(b.message, 2000), link = clean(b.link, 500);
      if (!SAFE_ID.test(jobId) || message.length < 5) throw fail(400, 'Enter a valid job and cover letter.');
      if (link && !/^https:\/\//i.test(link)) throw fail(400, 'Portfolio link must start with https://');

      const job = (await db.ref(`graduateJobs/${jobId}`).once('value')).val();
      if (!job || job.status !== 'active') throw fail(404, 'This job is no longer available.');
      if (job.companyId === uid) throw fail(403, 'You cannot apply to your own company job.');

      const authUser = await admin.auth().getUser(uid);
      const applicant = {
        uid, name: clean(user.fullName || user.username || 'Graduate', 80),
        email: clean(authUser.email || '', 160), message, link, appliedAt: Date.now()
      };
      const applied = await db.ref(`jobApplicants/${jobId}/${uid}`).transaction(old => old ? undefined : applicant);
      if (!applied.committed) throw fail(409, 'You have already applied for this job.');
      await db.ref(`graduateJobs/${jobId}/applicantCount`).transaction(n => Number(n || 0) + 1);
      return res.json({ ok: true });
    } catch (e) { return reply(res, e); }
  });

  // ---------- admin: verify or reject a company ----------
  app.post('/api/business/admin/company/review', async (req, res) => {
    try {
      const actor = await requireAdmin(req);
      const b = req.body || {};
      const uid = String(b.uid || '');
      if (!SAFE_ID.test(uid)) throw fail(400, 'Invalid company.');
      const reason = clean(b.reason, 300);
      if (b.decision !== 'verify' && b.decision !== 'reject') throw fail(400, 'Decision must be verify or reject.');
      if (b.decision === 'reject' && reason.length < 5) throw fail(400, 'Give a reason for rejecting this company.');
      const ref = db.ref(`companies/${uid}`);
      const before = (await ref.once('value')).val();
      if (!before) throw fail(404, 'Company not found.');
      const after = b.decision === 'verify'
        ? { status: 'verified', verifiedAt: Date.now(), verifiedBy: actor.uid, rejectReason: null }
        : { status: 'rejected', rejectedAt: Date.now(), rejectedBy: actor.uid, rejectReason: reason };
      await ref.update(after);
      await writeAudit(actor, b.decision === 'verify' ? 'company_verify' : 'company_reject', 'company', uid, reason, { status: before.status }, { status: after.status });
      return res.json({ ok: true, status: after.status });
    } catch (e) { return reply(res, e); }
  });

  // ---------- admin: approve or reject a graduate job ----------
  app.post('/api/business/admin/job/review', async (req, res) => {
    try {
      const actor = await requireAdmin(req);
      const b = req.body || {};
      const jobId = String(b.jobId || '');
      if (!SAFE_ID.test(jobId)) throw fail(400, 'Invalid job.');
      if (b.decision !== 'approve' && b.decision !== 'reject') throw fail(400, 'Decision must be approve or reject.');
      const reason = clean(b.reason, 300);
      if (b.decision === 'reject' && reason.length < 5) throw fail(400, 'Give a reason for rejecting this job.');
      const jobRef = db.ref(`graduateJobs/${jobId}`);
      const job = (await jobRef.once('value')).val();
      if (!job) throw fail(404, 'Job not found.');
      if (job.status !== 'pending_review') throw fail(400, 'Only jobs awaiting review can be decided.');

      if (b.decision === 'approve') {
        await jobRef.update({ status: 'active', approvedAt: Date.now(), approvedBy: actor.uid });
        await writeAudit(actor, 'job_approve', 'graduate_job', jobId, '', { status: job.status }, { status: 'active' });
        return res.json({ ok: true, status: 'active' });
      }
      await jobRef.update({ status: 'rejected', rejectedAt: Date.now(), rejectedBy: actor.uid, rejectReason: reason });
      const refunded = await refundOnce(job.companyId, Number(job.postingFee || FEE), `job_${jobId}`, `Graduate job rejected: refund`);
      await writeAudit(actor, 'job_reject', 'graduate_job', jobId, reason, { status: job.status }, { status: 'rejected', refunded });
      return res.json({ ok: true, status: 'rejected', refunded });
    } catch (e) { return reply(res, e); }
  });
}
