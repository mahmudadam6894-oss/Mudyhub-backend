// MudyHub V1 — Jobs: listings only. No money moves through a job.
// Register from server.js (after registerBusiness):
//   registerJobs({ app, admin, db, authenticatedUid });
//
//   POST /api/jobs/apply               { jobId, message, link }      applicant
//   POST /api/jobs/withdraw            { jobId }                     applicant
//   POST /api/jobs/applicant/decide    { jobId, applicantUid, decision: 'shortlist'|'hire'|'reject' }  company owner
//   POST /api/jobs/close               { jobId }                     company owner
//
// Data written by this file:
//   graduateJobs/{jobId}/applicantCount, hiredCount, status        (status: active | filled | closed)
//   jobApplicants/{jobId}/{uid}          the application (private to applicant and company)
//   userApplications/{uid}/{jobId}       applicant's own copy, for "My Applications"
// Jobs are created and approved by business-routes.js (posting fee + admin approval).

export default function registerJobs({ app, admin, db, authenticatedUid }) {
  const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
  const STATUSES = ['applied', 'shortlisted', 'hired', 'rejected', 'withdrawn'];
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const reply = (res, e) => {
    const status = e.status || (e.message === 'Unauthorized' ? 401 : 500);
    if (status === 500) console.error('[jobs]', e);
    return res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
  };

  async function activeUser(uid) {
    const authUser = await admin.auth().getUser(uid);
    if (!authUser.emailVerified) throw fail(403, 'Verify your email address before applying.');
    const u = (await db.ref(`users/${uid}`).once('value')).val();
    if (!u) throw fail(404, 'User account not found.');
    if (u.banned === true || u.status === 'banned' || u.walletFrozen === true) throw fail(403, 'Your account is restricted.');
    return { user: u, email: authUser.email || '' };
  }

  async function loadJob(jobId) {
    if (!SAFE_ID.test(jobId)) throw fail(400, 'Invalid job.');
    const job = (await db.ref(`graduateJobs/${jobId}`).once('value')).val();
    if (!job) throw fail(404, 'This job does not exist.');
    return job;
  }

  // Keep the job's counters and the applicant's copy in step with the main application record.
  async function setApplicationStatus(jobId, uid, status, extra = {}) {
    const now = Date.now();
    await db.ref(`jobApplicants/${jobId}/${uid}`).update({ status, updatedAt: now, ...extra });
    await db.ref(`userApplications/${uid}/${jobId}`).update({ status, updatedAt: now });
  }

  // ---------- apply ----------
  app.post('/api/jobs/apply', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const { user, email } = await activeUser(uid);
      const b = req.body || {};
      const jobId = clean(b.jobId, 100), message = clean(b.message, 2000), link = clean(b.link, 500);
      if (message.length < 5) throw fail(400, 'Write a short cover letter (at least 5 characters).');
      if (link && !/^https:\/\//i.test(link)) throw fail(400, 'Portfolio link must start with https://');
      const job = await loadJob(jobId);
      if (job.status !== 'active') throw fail(400, 'This job is not accepting applications.');
      if (job.companyId === uid) throw fail(403, 'You cannot apply to your own job.');

      const now = Date.now();
      const applicant = {
        uid, jobId, status: 'applied', name: clean(user.fullName || user.username || 'Applicant', 80),
        email: clean(email, 160), message, link, appliedAt: now, updatedAt: now
      };
      const applied = await db.ref(`jobApplicants/${jobId}/${uid}`).transaction(old => old ? undefined : applicant);
      if (!applied.committed) throw fail(409, 'You have already applied for this job.');
      await db.ref(`graduateJobs/${jobId}/applicantCount`).transaction(n => Number(n || 0) + 1);
      await db.ref(`userApplications/${uid}/${jobId}`).set({
        jobId, title: clean(job.title, 120), companyName: clean(job.companyName, 120),
        status: 'applied', appliedAt: now, updatedAt: now
      });
      return res.json({ ok: true, status: 'applied' });
    } catch (e) { return reply(res, e); }
  });

  // ---------- applicant withdraws ----------
  app.post('/api/jobs/withdraw', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const jobId = clean((req.body || {}).jobId, 100);
      if (!SAFE_ID.test(jobId)) throw fail(400, 'Invalid job.');
      const app_ = (await db.ref(`jobApplicants/${jobId}/${uid}`).once('value')).val();
      if (!app_) throw fail(404, 'You have not applied for this job.');
      if (app_.status !== 'applied' && app_.status !== 'shortlisted') throw fail(400, 'This application can no longer be withdrawn.');
      await setApplicationStatus(jobId, uid, 'withdrawn');
      await db.ref(`graduateJobs/${jobId}/applicantCount`).transaction(n => Math.max(0, Number(n || 0) - 1));
      return res.json({ ok: true, status: 'withdrawn' });
    } catch (e) { return reply(res, e); }
  });

  // ---------- company decides on an applicant ----------
  app.post('/api/jobs/applicant/decide', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const b = req.body || {};
      const jobId = clean(b.jobId, 100), applicantUid = clean(b.applicantUid, 128);
      if (!SAFE_ID.test(applicantUid)) throw fail(400, 'Invalid applicant.');
      const job = await loadJob(jobId);
      if (job.companyId !== uid) throw fail(403, 'Only the company that posted this job can decide.');
      if (job.status !== 'active' && job.status !== 'filled') throw fail(400, 'This job is closed.');
      const current = (await db.ref(`jobApplicants/${jobId}/${applicantUid}`).once('value')).val();
      if (!current) throw fail(404, 'Applicant not found.');
      if (current.status === 'withdrawn') throw fail(400, 'This applicant has withdrawn.');

      if (b.decision === 'shortlist') {
        if (current.status !== 'applied') throw fail(400, 'Only new applicants can be shortlisted.');
        await setApplicationStatus(jobId, applicantUid, 'shortlisted');
        return res.json({ ok: true, status: 'shortlisted' });
      }
      if (b.decision === 'reject') {
        if (current.status === 'hired') throw fail(400, 'A hired applicant cannot be rejected.');
        await setApplicationStatus(jobId, applicantUid, 'rejected');
        return res.json({ ok: true, status: 'rejected' });
      }
      if (b.decision === 'hire') {
        if (current.status === 'hired') throw fail(400, 'This applicant is already hired.');
        if (current.status === 'rejected') throw fail(400, 'Rejected applicants cannot be hired.');
        // Count the hire once, even if the request is repeated.
        const positions = Math.max(1, Number(job.positions || 1));
        await setApplicationStatus(jobId, applicantUid, 'hired', { hiredAt: Date.now() });
        const counted = await db.ref(`graduateJobs/${jobId}/hiredCount`).transaction(n => Number(n || 0) + 1);
        const hiredCount = Number(counted.snapshot.val() || 0);
        if (hiredCount >= positions) await db.ref(`graduateJobs/${jobId}`).update({ status: 'filled', filledAt: Date.now() });
        return res.json({ ok: true, status: 'hired', hiredCount, positions });
      }
      throw fail(400, 'Decision must be shortlist, hire or reject.');
    } catch (e) { return reply(res, e); }
  });

  // ---------- company closes its listing ----------
  app.post('/api/jobs/close', async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const jobId = clean((req.body || {}).jobId, 100);
      const job = await loadJob(jobId);
      if (job.companyId !== uid) throw fail(403, 'Only the company that posted this job can close it.');
      if (job.status === 'closed') return res.json({ ok: true, status: 'closed' });
      if (job.status !== 'active' && job.status !== 'filled') throw fail(400, 'Only live jobs can be closed.');
      await db.ref(`graduateJobs/${jobId}`).update({ status: 'closed', closedAt: Date.now() });
      return res.json({ ok: true, status: 'closed' });
    } catch (e) { return reply(res, e); }
  });
}
