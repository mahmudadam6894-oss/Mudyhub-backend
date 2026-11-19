
// MudyHub V1 — Business: company verification, graduate-job posting and applications.
// Company registration no longer depends on Marketplace seller verification.
//
// Client endpoints
//   POST /api/business/register
//   POST /api/business/jobs/create
//   POST /api/business/jobs/apply
//
// Admin endpoints
//   POST /api/business/admin/company/review
//   POST /api/business/admin/job/review
//
// Money rules:
// - Job posting fee is charged on the server.
// - Fee is retained when a job is approved.
// - Fee is refunded exactly once if a job is rejected or publication fails.

export default function registerBusiness({
  app,
  admin,
  db,
  authenticatedUid,
  requireAdmin,
  writeAudit
}) {
  const FEE = 5000;
  const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

  const fail = (status, message) =>
    Object.assign(new Error(message), { status });

  const clean = (value, max) =>
    String(value ?? '')
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, max);

  const reply = (res, error) => {
    const status =
      error.status ||
      (error.message === 'Unauthorized' ? 401 :
       error.message === 'Forbidden' ? 403 : 500);

    if (status === 500) {
      console.error('[business]', error);
    }

    return res.status(status).json({
      error: status === 500
        ? 'Something went wrong. Please try again.'
        : error.message
    });
  };

  // Account access check.
  // IMPORTANT: No sellerVerified or sellerExpiry requirement here.
  async function activeUser(uid) {
    const authUser = await admin.auth().getUser(uid);

    if (!authUser.emailVerified) {
      throw fail(403, 'Verify your email address first.');
    }

    const snap = await db.ref(`users/${uid}`).once('value');
    const user = snap.val();

    if (!user) {
      throw fail(404, 'User account not found.');
    }

    if (
      user.banned === true ||
      user.status === 'banned' ||
      user.walletFrozen === true
    ) {
      throw fail(403, 'Your account or wallet is restricted.');
    }

    return { user, authUser };
  }

  // Refund protection: a claim can only be refunded once.
  async function refundOnce(uid, amount, claimKey, note) {
    const result = await db.ref(`users/${uid}`).transaction(user => {
      if (!user) return user;

      const keys = user.businessFeeRefundClaims || {};

      if (keys[claimKey]) return user;

      user.walletBalance =
        Number(user.walletBalance || 0) + amount;

      keys[claimKey] = {
        amount,
        at: Date.now()
      };

      user.businessFeeRefundClaims = keys;

      return user;
    });

    if (
      result.committed &&
      (await db.ref(
        `users/${uid}/businessFeeRefundClaims/${claimKey}`
      ).once('value')).exists()
    ) {
      await db.ref(
        `walletLedger/${uid}/business_refund_${claimKey}`
      ).set({
        type: 'job_post_refund',
        direction: 'credit',
        amount,
        reference: claimKey,
        description: note,
        status: 'completed',
        createdAt: Date.now()
      });
    }

    return result.committed;
  }

  // --------------------------------------------------
  // COMPANY REGISTRATION
  // --------------------------------------------------
  app.post('/api/business/register', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const { user } = await activeUser(uid);

      const body = req.body || {};

      const companyName = clean(body.companyName, 120);
      const cacNumber = clean(body.cacNumber, 60);
      const email = clean(body.email, 160).toLowerCase();
      const website = clean(body.website, 300);

      if (
        companyName.length < 2 ||
        cacNumber.length < 3 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        throw fail(
          400,
          'Enter a valid company name, CAC number and official email.'
        );
      }

      if (website && !/^https:\/\//i.test(website)) {
        throw fail(400, 'Website must start with https://');
      }

      const companyRef = db.ref(`companies/${uid}`);
      const old = (await companyRef.once('value')).val();

      if (old?.status === 'verified') {
        throw fail(409, 'This company is already verified.');
      }

      if (old?.status === 'pending') {
        throw fail(409, 'Your company is already awaiting review.');
      }

      const now = Date.now();

      await companyRef.set({
        uid,
        companyName,
        cacNumber,
        email,
        website,
        status: 'pending',
        createdAt: old?.createdAt || now,
        updatedAt: now,
        submittedBy: uid,
        submittedName: clean(
          user.fullName || user.username || 'MudyHub User',
          80
        ),
        rejectReason: null
      });

      return res.json({
        ok: true,
        status: 'pending',
        message: 'Company application submitted for review.'
      });

    } catch (error) {
      return reply(res, error);
    }
  });

  // --------------------------------------------------
  // CREATE GRADUATE JOB
  // Only an approved company can post jobs.
  // --------------------------------------------------
  app.post('/api/business/jobs/create', async (req, res) => {
    let uid = null;
    let claimRef = null;
    let debited = false;
    let jobRef = null;
    let requestId = '';

    try {
      uid = await authenticatedUid(req);
      await activeUser(uid);

      const company = (
        await db.ref(`companies/${uid}`).once('value')
      ).val();

      if (!company || company.status !== 'verified') {
        throw fail(
          403,
          'Your company must be verified before posting jobs.'
        );
      }

      const body = req.body || {};

      const title = clean(body.title, 120);
      const jobType = clean(body.jobType, 40);
      const salary = clean(body.salary, 100);
      const location = clean(body.location, 120);
      const description = clean(body.description, 3000);

      requestId = clean(body.requestId, 100);

      if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestId)) {
        throw fail(400, 'Invalid request ID.');
      }

      if (
        title.length < 3 ||
        !jobType ||
        salary.length < 2 ||
        location.length < 2 ||
        description.length < 20
      ) {
        throw fail(
          400,
          'Complete all job details. Description must be at least 20 characters.'
        );
      }

      claimRef = db.ref(
        `businessJobRequests/${uid}/${requestId}`
      );

      const claim = await claimRef.transaction(value =>
        value
          ? undefined
          : {
              state: 'processing',
              fee: FEE,
              at: Date.now()
            }
      );

      if (!claim.committed) {
        throw fail(409, 'This posting request was already submitted.');
      }

      const debit = await db.ref(`users/${uid}`).transaction(user => {
        if (!user) return user;

        const balance = Number(user.walletBalance || 0);

        if (!Number.isFinite(balance) || balance < FEE) {
          return;
        }

        const keys = user.businessFeeClaims || {};

        if (keys[requestId]) return;

        user.walletBalance = balance - FEE;

        keys[requestId] = {
          amount: FEE,
          at: Date.now()
        };

        user.businessFeeClaims = keys;

        return user;
      });

      if (!debit.committed) {
        await claimRef.remove().catch(() => {});
        throw fail(
          400,
          'Insufficient wallet balance. Top up and try again.'
        );
      }

      debited = true;

      const now = Date.now();

      jobRef = db.ref('graduateJobs').push();

      await jobRef.set({
        id: jobRef.key,
        companyId: uid,
        companyName: clean(company.companyName, 120),
        title,
        jobType,
        salary,
        location,
        description,
        status: 'pending_review',
        applicantCount: 0,
        postingFee: FEE,
        createdAt: now
      });

      await db.ref(
        `walletLedger/${uid}/business_job_fee_${requestId}`
      ).set({
        type: 'job_post_fee',
        direction: 'debit',
        amount: FEE,
        reference: jobRef.key,
        description:
          `Graduate job posting (awaiting review): ${title}`,
        status: 'completed',
        createdAt: now
      });

      await claimRef.update({
        state: 'submitted',
        jobId: jobRef.key,
        submittedAt: now
      });

      return res.json({
        ok: true,
        jobId: jobRef.key,
        status: 'pending_review',
        fee: FEE
      });

    } catch (error) {
      try {
        if (debited && uid && requestId) {
          if (jobRef) {
            await jobRef.remove().catch(() => {});
          }

          const refunded = await refundOnce(
            uid,
            FEE,
            requestId,
            'Graduate job posting refund (not published)'
          );

          if (refunded && claimRef) {
            await claimRef.update({
              state: 'refunded',
              refundedAt: Date.now()
            }).catch(() => {});
          }

        } else if (claimRef) {
          await claimRef.remove().catch(() => {});
        }

      } catch (refundError) {
        console.error('[business] posting refund failed', refundError);
      }

      return reply(res, error);
    }
  });

  // --------------------------------------------------
  // APPLY FOR A PUBLISHED JOB
  // --------------------------------------------------
  app.post('/api/business/jobs/apply', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const { user, authUser } = await activeUser(uid);

      const body = req.body || {};

      const jobId = clean(body.jobId, 100);
      const message = clean(body.message, 2000);
      const link = clean(body.link, 500);

      if (!SAFE_ID.test(jobId) || message.length < 5) {
        throw fail(400, 'Enter a valid job and cover letter.');
      }

      if (link && !/^https:\/\//i.test(link)) {
        throw fail(400, 'Portfolio link must start with https://');
      }

      const job = (
        await db.ref(`graduateJobs/${jobId}`).once('value')
      ).val();

      if (!job || job.status !== 'active') {
        throw fail(404, 'This job is no longer available.');
      }

      if (job.companyId === uid) {
        throw fail(403, 'You cannot apply to your own company job.');
      }

      const applicant = {
        uid,
        name: clean(
          user.fullName || user.username || 'Graduate',
          80
        ),
        email: clean(authUser.email || '', 160),
        message,
        link,
        appliedAt: Date.now()
      };

      const applied = await db.ref(
        `jobApplicants/${jobId}/${uid}`
      ).transaction(old => old ? undefined : applicant);

      if (!applied.committed) {
        throw fail(409, 'You have already applied for this job.');
      }

      await db.ref(
        `graduateJobs/${jobId}/applicantCount`
      ).transaction(count => Number(count || 0) + 1);

      return res.json({ ok: true });

    } catch (error) {
      return reply(res, error);
    }
  });

  // --------------------------------------------------
  // ADMIN: VERIFY OR REJECT A COMPANY
  // --------------------------------------------------
  app.post('/api/business/admin/company/review', async (req, res) => {
    try {
      const actor = await requireAdmin(req);
      const body = req.body || {};

      const uid = String(body.uid || '');

      if (!SAFE_ID.test(uid)) {
        throw fail(400, 'Invalid company.');
      }

      const reason = clean(body.reason, 300);

      if (
        body.decision !== 'verify' &&
        body.decision !== 'reject'
      ) {
        throw fail(400, 'Decision must be verify or reject.');
      }

      if (body.decision === 'reject' && reason.length < 5) {
        throw fail(
          400,
          'Give a reason for rejecting this company.'
        );
      }

      const companyRef = db.ref(`companies/${uid}`);
      const before = (await companyRef.once('value')).val();

      if (!before) {
        throw fail(404, 'Company not found.');
      }

      if (before.status !== 'pending') {
        throw fail(
          400,
          'Only company applications awaiting review can be decided.'
        );
      }

      const now = Date.now();

      const after = body.decision === 'verify'
        ? {
            status: 'verified',
            verifiedAt: now,
            verifiedBy: actor.uid,
            rejectReason: null
          }
        : {
            status: 'rejected',
            rejectedAt: now,
            rejectedBy: actor.uid,
            rejectReason: reason
          };

      await companyRef.update(after);

      await writeAudit(
        actor,
        body.decision === 'verify'
          ? 'company_verify'
          : 'company_reject',
        'company',
        uid,
        reason,
        { status: before.status },
        { status: after.status }
      );

      return res.json({
        ok: true,
        status: after.status
      });

    } catch (error) {
      return reply(res, error);
    }
  });

  // --------------------------------------------------
  // ADMIN: APPROVE OR REJECT A GRADUATE JOB
  // --------------------------------------------------
  app.post('/api/business/admin/job/review', async (req, res) => {
    try {
      const actor = await requireAdmin(req);
      const body = req.body || {};

      const jobId = String(body.jobId || '');

      if (!SAFE_ID.test(jobId)) {
        throw fail(400, 'Invalid job.');
      }

      if (
        body.decision !== 'approve' &&
        body.decision !== 'reject'
      ) {
        throw fail(400, 'Decision must be approve or reject.');
      }

      const reason = clean(body.reason, 300);

      if (body.decision === 'reject' && reason.length < 5) {
        throw fail(400, 'Give a reason for rejecting this job.');
      }

      const jobRef = db.ref(`graduateJobs/${jobId}`);
      const job = (await jobRef.once('value')).val();

      if (!job) {
        throw fail(404, 'Job not found.');
      }

      if (job.status !== 'pending_review') {
        throw fail(
          400,
          'Only jobs awaiting review can be decided.'
        );
      }

      if (body.decision === 'approve') {
        await jobRef.update({
          status: 'active',
          approvedAt: Date.now(),
          approvedBy: actor.uid
        });

        await writeAudit(
          actor,
          'job_approve',
          'graduate_job',
          jobId,
          '',
          { status: job.status },
          { status: 'active' }
        );

        return res.json({
          ok: true,
          status: 'active'
        });
      }

      await jobRef.update({
        status: 'rejected',
        rejectedAt: Date.now(),
        rejectedBy: actor.uid,
        rejectReason: reason
      });

      const refunded = await refundOnce(
        job.companyId,
        Number(job.postingFee || FEE),
        `job_${jobId}`,
        'Graduate job rejected: refund'
      );

      await writeAudit(
        actor,
        'job_reject',
        'graduate_job',
        jobId,
        reason,
        { status: job.status },
        { status: 'rejected', refunded }
      );

      return res.json({
        ok: true,
        status: 'rejected',
        refunded
      });

    } catch (error) {
      return reply(res, error);
    }
  });
}
