// MudyHub True Connection — server-enforced routes (Express + Firebase Admin SDK)
//
// Mount in server.js AFTER authenticatedUid / requireAdmin / writeAudit are defined:
//   require('./true-connection-routes')({ app, admin, db, authenticatedUid, requireAdmin, writeAudit });
//
// The browser NEVER writes any trueConnection* node (database rules deny it). Everything that
// decides who is eligible, who is matched, who is connected and when a connection ends happens here.
//
// Data (all server-written):
//   trueConnectionEligibility/{uid}      { eligible, ageBand, rulesAcceptedAt, rulesVersion, suspended }
//   trueConnectionProfiles/{uid}         private matching profile (no name / phone / email / links)
//   trueConnectionRecommendations/{uid}  { mood, generatedAt, candidates:{uid:{...}} }  (exactly 3 or fewer)
//   trueConnectionRequests/{id}          { fromUid,toUid,status:pending|accepted|declined|cancelled,createdAt }
//   trueConnectionLive/{uid}             connectionId  (one live connection per user — transaction-claimed)
//   trueConnections/{id}                 { participants:{a:true,b:true}, status:active|ending|closed, ... }
//   trueConnectionDeclines/{pairKey}     timestamp (cool-off so a declined pair is not re-suggested)
//   trueConnectionSafetyReports/{id}     { connectionId,reporterUid,reportedUid,reason,status:new|reviewed }
//   chatMembers/tc_{id}, userChats/{uid}/tc_{id}   created on mutual acceptance, removed on close

export default function registerTrueConnection({ app, admin, db, authenticatedUid, requireAdmin, writeAudit }) {
  const RULES_VERSION = 'v1';
  const BANDS = ['18-24', '25-34', '35+'];
  const MOODS = ['happy', 'sad'];
  const COMM = ['any', 'text', 'voice', 'video'];
  const AGE_PREF = ['any', ...BANDS];
  const LOC_PREF = ['any', 'same-area'];
  const ENDING_MS = 7 * 24 * 60 * 60 * 1000;
  const DECLINE_COOLOFF_MS = 30 * 24 * 60 * 60 * 1000;
  const REC_COOLDOWN_MS = 20 * 1000;
  const MAX_INCOMING_PENDING = 5;
  const POOL_LIMIT = 400;
  const REQUIRE_VERIFIED = String(process.env.TC_REQUIRE_VERIFIED || 'true') !== 'false';

  const val = async path => (await db.ref(path).once('value')).val();
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const split = v => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const overlap = (a, b) => a.filter(x => b.includes(x)).length;
  const pairKey = (a, b) => [a, b].sort().join('_');
  const now = () => Date.now();
  // Contact details are not allowed inside True Connection profile text (identity stays hidden until mutual acceptance).
  const CONTACT_RE = /(https?:\/\/|www\.|@[a-z0-9_.]{3,}|\b\d{9,}\b|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const fail = (status, message) => { throw new HttpError(status, message); };
  const route = (path, handler) => app.post(path, async (req, res) => {
    try {
      const uid = await authenticatedUid(req).catch(() => null);
      if (!uid) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
      const out = await handler(uid, req.body || {}, req);
      return res.json({ ok: true, ...(out || {}) });
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ ok: false, error: e.message });
      console.error('[true-connection]', path, e && e.message ? e.message : e);
      return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
    }
  });

  // ---------------------------------------------------------------- eligibility
  async function eligibilityOf(uid) {
    const e = await val(`trueConnectionEligibility/${uid}`);
    if (!e || e.eligible !== true || e.suspended === true || !BANDS.includes(e.ageBand) || e.rulesVersion !== RULES_VERSION) return null;
    const user = await val(`users/${uid}`);
    if (!user || user.banned === true || user.walletFrozen === true) return null;
    return e;
  }
  async function requireEligible(uid) {
    const e = await eligibilityOf(uid);
    if (!e) fail(403, 'True Connection is available to verified adults who have joined and accepted the safety rules.');
    return e;
  }
  const ageBandFromDob = dobStr => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dobStr || ''));
    if (!m) return null;
    const dob = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(dob) || dob.getUTCFullYear() !== +m[1] || dob.getUTCMonth() !== +m[2] - 1) return null;
    const t = new Date();
    let age = t.getUTCFullYear() - dob.getUTCFullYear();
    if (t.getUTCMonth() < dob.getUTCMonth() || (t.getUTCMonth() === dob.getUTCMonth() && t.getUTCDate() < dob.getUTCDate())) age--;
    if (age < 18 || age > 100) return age < 18 ? 'minor' : null;
    return age <= 24 ? '18-24' : age <= 34 ? '25-34' : '35+';
  };

  route('/api/tc/join', async (uid, body) => {
    if (body.acceptRules !== true) fail(400, 'You must accept the True Connection safety and community rules.');
    const existing = await val(`trueConnectionEligibility/${uid}`);
    if (existing && existing.suspended === true) fail(403, 'Your True Connection access is suspended.');
    const user = await val(`users/${uid}`);
    if (!user || user.banned === true) fail(403, 'Account not available.');
    const authRecord = await admin.auth().getUser(uid).catch(() => null);
    if (!authRecord || authRecord.disabled) fail(403, 'Your account is unavailable.');
    if (!authRecord.emailVerified) fail(403, 'Verify your email address before joining True Connection.');
    const verified = user.verified === true || user.kycStatus === 'approved' || user.kycStatus === 'verified';
    if (REQUIRE_VERIFIED && !verified) fail(403, 'Complete MudyHub account verification first (Profile → Verification), then come back.');
    if (existing && existing.approval === 'rejected') fail(403, 'Your True Connection application was not approved. Contact Support if you think this is a mistake.');
    const band = ageBandFromDob(body.dob);
    if (band === 'minor') fail(403, 'True Connection is for adults aged 18 and above.');
    if (!band) fail(400, 'Enter a valid date of birth (YYYY-MM-DD).');
    // Admin approval is on by default (platformSettings/trueConnectionRequiresApproval !== false).
    const settings = (await val('platformSettings')) || {};
    const needsApproval = settings.trueConnectionRequiresApproval !== false;
    // Only the age band is stored — never the date of birth.
    await db.ref(`trueConnectionEligibility/${uid}`).set({
      eligible: !needsApproval, approval: needsApproval ? 'pending' : 'approved', appliedAt: now(), ageBand: band, ageSelfDeclared: true, accountVerified: verified,
      rulesVersion: RULES_VERSION, rulesAcceptedAt: now(), suspended: false
    });
    return { ageBand: band, pendingApproval: needsApproval };
  });

  // ---------------------------------------------------------------- profile
  route('/api/tc/profile', async (uid, b) => {
    const e = await requireEligible(uid);
    const live = await val(`trueConnectionLive/${uid}`);
    const p = {
      uid, active: b.active !== false, ageBand: e.ageBand,
      bio: clean(b.bio, 160), about: clean(b.about, 500), intentions: clean(b.intentions, 160),
      values: clean(b.values, 160), interests: clean(b.interests, 160), location: clean(b.location, 80),
      communication: COMM.includes(b.communication) ? b.communication : 'any',
      agePreference: AGE_PREF.includes(b.agePreference) ? b.agePreference : 'any',
      locationPreference: LOC_PREF.includes(b.locationPreference) ? b.locationPreference : 'any',
      updatedAt: now()
    };
    if (p.bio.length < 10 || p.about.length < 20) fail(400, 'Please write a short bio (10+ characters) and a description of yourself (20+ characters).');
    if (!p.location) fail(400, 'Add your city or state.');
    for (const k of ['bio', 'about', 'intentions', 'values', 'interests', 'location'])
      if (CONTACT_RE.test(p[k])) fail(400, 'Do not include phone numbers, emails, links or handles. Contact details can be shared after you connect.');
    const user = await val(`users/${uid}`);
    p.avatarUrl = clean((user && (user.avatarUrl || user.profilePic)) || '', 2000);
    if (!/^(https?:\/\/|data:image\/)/i.test(p.avatarUrl)) p.avatarUrl = '';
    if (p.avatarUrl.length > 1500 && p.avatarUrl.startsWith('data:')) p.avatarUrl = ''; // avoid huge data URLs in shortlists
    await db.ref(`trueConnectionProfiles/${uid}`).set(p);
    if (!p.active) await db.ref(`trueConnectionRecommendations/${uid}`).remove();
    return { profile: p, hasLive: !!live };
  });

  // ---------------------------------------------------------------- matching
  function compatibility(me, other, mood) {
    if (me.agePreference !== 'any' && me.agePreference !== other.ageBand) return -1;
    if (other.agePreference !== 'any' && other.agePreference !== me.ageBand) return -1;
    const sameArea = String(me.location).toLowerCase() === String(other.location).toLowerCase();
    if ((me.locationPreference === 'same-area' || other.locationPreference === 'same-area') && !sameArea) return -1;
    if (me.communication !== 'any' && other.communication !== 'any' && me.communication !== other.communication) return -1;
    return overlap(split(me.interests), split(other.interests)) * 3
      + overlap(split(me.values), split(other.values)) * 4
      + overlap(split(me.intentions), split(other.intentions)) * 2
      + (sameArea ? 2 : 0)
      + (other.mood === mood ? 1 : 0);
  }
  const publicCard = (uid, p) => ({
    uid, avatarUrl: p.avatarUrl || '', bio: p.bio || '', about: p.about || '', intentions: p.intentions || '',
    values: p.values || '', interests: p.interests || '', ageBand: p.ageBand || '', location: p.location || '',
    communication: p.communication || 'any'
  });

  route('/api/tc/recommend', async (uid, b) => {
    await requireEligible(uid);
    if (!MOODS.includes(b.mood)) fail(400, 'Choose Happy or Sad.');
    if (await val(`trueConnectionLive/${uid}`)) fail(409, 'You already have an active or resolving connection.');
    const me = await val(`trueConnectionProfiles/${uid}`);
    if (!me || me.active !== true) fail(400, 'Save your True Connection profile first.');
    const last = Number(await val(`trueConnectionMatchRateLimit/${uid}`) || 0);
    if (now() - last < REC_COOLDOWN_MS) fail(429, 'Please wait a few seconds before refreshing.');
    await db.ref(`trueConnectionMatchRateLimit/${uid}`).set(now());

    const [poolSnap, myBlocks, myDeclines] = await Promise.all([
      db.ref('trueConnectionProfiles').orderByChild('active').equalTo(true).limitToFirst(POOL_LIMIT).once('value'),
      val(`blocks/${uid}`), val('trueConnectionDeclines')
    ]);
    const blocked = myBlocks || {}, declines = myDeclines || {};
    const scored = [];
    const pool = poolSnap.val() || {};
    // Moods are stored per recommendation run on the *seeker* only; candidates carry the mood they last chose.
    const moods = (await val('trueConnectionMoods')) || {};
    for (const [cu, cp] of Object.entries(pool)) {
      if (cu === uid || !cp || cp.uid !== cu) continue;
      if (blocked[cu] === true) continue;
      if (declines[pairKey(uid, cu)] && now() - declines[pairKey(uid, cu)] < DECLINE_COOLOFF_MS) continue;
      if (!(await eligibilityOf(cu))) continue;
      if (await val(`trueConnectionLive/${cu}`)) continue;
      if ((await val(`blocks/${cu}/${uid}`)) === true) continue;
      const score = compatibility(me, { ...cp, mood: moods[cu] }, b.mood);
      if (score >= 0) scored.push({ cu, cp, score });
    }
    scored.sort((x, y) => y.score - x.score || x.cu.localeCompare(y.cu));
    const top = scored.slice(0, 3);
    const candidates = {};
    top.forEach(({ cu, cp }) => { candidates[cu] = publicCard(cu, cp); });
    await Promise.all([
      db.ref(`trueConnectionMoods/${uid}`).set(b.mood),
      db.ref(`trueConnectionRecommendations/${uid}`).set({ mood: b.mood, generatedAt: now(), candidates })
    ]);
    return { count: top.length, message: top.length === 3 ? 'Three recommendations are ready.' : 'Not enough suitable verified members yet. Check back soon.' };
  });

  // ---------------------------------------------------------------- requests
  route('/api/tc/request', async (uid, b) => {
    await requireEligible(uid);
    const target = clean(b.targetUid, 128);
    if (!target || target === uid) fail(400, 'Invalid selection.');
    const recs = await val(`trueConnectionRecommendations/${uid}`);
    if (!recs || !recs.candidates || !recs.candidates[target]) fail(403, 'You can only approach one of your three recommendations.');
    if (await val(`trueConnectionLive/${uid}`)) fail(409, 'You already have an active or resolving connection.');
    if (!(await eligibilityOf(target))) fail(409, 'This member is no longer available.');
    if (await val(`trueConnectionLive/${target}`)) fail(409, 'This member is no longer available.');
    if ((await val(`blocks/${uid}/${target}`)) === true || (await val(`blocks/${target}/${uid}`)) === true) fail(409, 'This member is no longer available.');
    const [out, inc] = await Promise.all([
      db.ref('trueConnectionRequests').orderByChild('fromUid').equalTo(uid).once('value'),
      db.ref('trueConnectionRequests').orderByChild('toUid').equalTo(target).once('value')
    ]);
    const outPending = Object.values(out.val() || {}).filter(r => r.status === 'pending');
    if (outPending.length) fail(409, 'You already have a pending request. Cancel it to approach someone else.');
    const incPending = Object.values(inc.val() || {}).filter(r => r.status === 'pending');
    if (incPending.some(r => r.fromUid === uid)) fail(409, 'Request already sent.');
    if (incPending.length >= MAX_INCOMING_PENDING) fail(409, 'This member is not available right now.');
    const rid = db.ref('trueConnectionRequests').push().key;
    await db.ref(`trueConnectionRequests/${rid}`).set({ id: rid, fromUid: uid, toUid: target, status: 'pending', createdAt: now() });
    await db.ref(`notifications/${target}`).push({ type: 'true_connection_request', requestId: rid, message: 'Someone would like to connect with you on True Connection.', createdAt: now(), read: false });
    return { requestId: rid };
  });

  route('/api/tc/cancel', async (uid, b) => {
    const rid = clean(b.requestId, 128);
    const r = await val(`trueConnectionRequests/${rid}`);
    if (!r || r.fromUid !== uid || r.status !== 'pending') fail(404, 'Request not found.');
    await db.ref(`trueConnectionRequests/${rid}/status`).set('cancelled');
    return {};
  });

  async function claimLive(uid, connId) {
    let ok = false;
    const res = await db.ref(`trueConnectionLive/${uid}`).transaction(cur => (cur ? undefined : connId));
    ok = res.committed && res.snapshot.val() === connId;
    return ok;
  }
  async function releaseLive(uid, connId) {
    await db.ref(`trueConnectionLive/${uid}`).transaction(cur => (cur === connId ? null : undefined)).catch(() => {});
  }

  route('/api/tc/respond', async (uid, b) => {
    const rid = clean(b.requestId, 128);
    const accept = b.accept === true;
    const r = await val(`trueConnectionRequests/${rid}`);
    if (!r || r.toUid !== uid || r.status !== 'pending') fail(404, 'This request is no longer available.');
    if (!accept) {
      const c = await db.ref(`trueConnectionRequests/${rid}/status`).transaction(cur => (cur === 'pending' ? 'declined' : undefined));
      if (!c.committed) fail(409, 'This request was already handled.');
      await db.ref(`trueConnectionDeclines/${pairKey(r.fromUid, uid)}`).set(now());
      return { status: 'declined' };
    }
    await requireEligible(uid);
    if (!(await eligibilityOf(r.fromUid))) fail(409, 'This member is no longer available.');
    if ((await val(`blocks/${uid}/${r.fromUid}`)) === true || (await val(`blocks/${r.fromUid}/${uid}`)) === true) fail(409, 'This request is no longer available.');
    // 1) claim the request so a double tap / second device can't accept twice
    const claim = await db.ref(`trueConnectionRequests/${rid}/status`).transaction(cur => (cur === 'pending' ? 'accepting' : undefined));
    if (!claim.committed) fail(409, 'This request was already handled.');
    const connId = db.ref('trueConnections').push().key;
    try {
      // 2) one live connection per person — claimed atomically for both
      if (!(await claimLive(uid, connId))) fail(409, 'You already have an active or resolving connection.');
      if (!(await claimLive(r.fromUid, connId))) { await releaseLive(uid, connId); fail(409, 'This member is no longer available.'); }
      const [a, bb] = [r.fromUid, uid].sort();
      const t = now();
      const participants = { [r.fromUid]: true, [uid]: true };
      await db.ref().update({
        [`trueConnections/${connId}`]: { id: connId, userA: a, userB: bb, participants, status: 'active', startedAt: t, requestId: rid },
        [`chatMembers/tc_${connId}`]: { connectionId: connId, members: participants, userA: a, userB: bb, createdAt: t },
        [`userChats/${r.fromUid}/tc_${connId}`]: { isTrueConnection: true, otherUid: uid, lastMessageText: 'True Connection started', lastMessageAt: t, lastMessageBy: 'system', read: false },
        [`userChats/${uid}/tc_${connId}`]: { isTrueConnection: true, otherUid: r.fromUid, lastMessageText: 'True Connection started', lastMessageAt: t, lastMessageBy: 'system', read: false },
        [`trueConnectionRequests/${rid}/status`]: 'accepted',
        [`trueConnectionRequests/${rid}/connectionId`]: connId,
        [`trueConnectionRecommendations/${uid}`]: null,
        [`trueConnectionRecommendations/${r.fromUid}`]: null
      });
      await cancelPendingFor([uid, r.fromUid], rid);
      await db.ref(`notifications/${r.fromUid}`).push({ type: 'true_connection_accepted', requestId: rid, message: 'Your True Connection request was accepted. Your private chat is ready.', createdAt: t, read: false });
      return { status: 'accepted', connectionId: connId, chatId: `tc_${connId}`, otherUid: r.fromUid };
    } catch (e) {
      await Promise.all([releaseLive(uid, connId), releaseLive(r.fromUid, connId)]);
      await db.ref(`trueConnectionRequests/${rid}/status`).transaction(cur => (cur === 'accepting' ? 'pending' : undefined)).catch(() => {});
      throw e;
    }
  });

  async function cancelPendingFor(uids, exceptId) {
    for (const u of uids) {
      for (const field of ['fromUid', 'toUid']) {
        const s = await db.ref('trueConnectionRequests').orderByChild(field).equalTo(u).once('value');
        const updates = {};
        Object.entries(s.val() || {}).forEach(([id, r]) => { if (id !== exceptId && r.status === 'pending') updates[`trueConnectionRequests/${id}/status`] = 'cancelled'; });
        if (Object.keys(updates).length) await db.ref().update(updates);
      }
    }
  }

  // ---------------------------------------------------------------- connection lifecycle
  async function closeConnection(id, reason, by) {
    const c = await val(`trueConnections/${id}`);
    if (!c || c.status === 'closed') return;
    const [a, bb] = [c.userA, c.userB];
    await db.ref().update({
      [`trueConnections/${id}/status`]: 'closed', [`trueConnections/${id}/closedAt`]: now(),
      [`trueConnections/${id}/closedReason`]: reason, [`trueConnections/${id}/closedBy`]: by || 'system',
      [`chatMembers/tc_${id}`]: null,
      [`userChats/${a}/tc_${id}`]: null, [`userChats/${bb}/tc_${id}`]: null,
      [`trueConnectionDecisions/${id}`]: null
    });
    await Promise.all([releaseLive(a, id), releaseLive(bb, id)]);
  }
  async function loadConnection(uid, id) {
    const c = await val(`trueConnections/${clean(id, 128)}`);
    if (!c || !c.participants || c.participants[uid] !== true) fail(404, 'Connection not found.');
    if (c.status === 'ending' && Number(c.endsAt || 0) <= now()) { await closeConnection(c.id, 'resolution_period_complete'); fail(409, 'This connection has ended.'); }
    if (c.status === 'closed') fail(409, 'This connection has ended.');
    return c;
  }

  route('/api/tc/end', async (uid, b) => {
    const c = await loadConnection(uid, b.connectionId);
    if (c.status !== 'active') fail(409, 'The seven-day resolution period has already started.');
    const endsAt = now() + ENDING_MS;
    const tx = await db.ref(`trueConnections/${c.id}/status`).transaction(cur => (cur === 'active' ? 'ending' : undefined));
    if (!tx.committed) fail(409, 'Already updated.');
    await db.ref(`trueConnections/${c.id}`).update({ endedBy: uid, endsAt, endRequestedAt: now() });
    await db.ref(`trueConnectionDecisions/${c.id}`).remove();
    const other = c.userA === uid ? c.userB : c.userA;
    await db.ref(`notifications/${other}`).push({ type: 'true_connection_ending', connectionId: c.id, message: 'Your True Connection has entered a seven-day resolution period.', createdAt: now(), read: false });
    return { endsAt };
  });

  route('/api/tc/continue', async (uid, b) => {
    const c = await loadConnection(uid, b.connectionId);
    if (c.status !== 'ending') fail(409, 'This connection is already active.');
    await db.ref(`trueConnectionDecisions/${c.id}/${uid}`).set('continue');
    const d = (await val(`trueConnectionDecisions/${c.id}`)) || {};
    if (d[c.userA] === 'continue' && d[c.userB] === 'continue') {
      await db.ref(`trueConnections/${c.id}`).update({ status: 'active', endsAt: null, endedBy: null, endRequestedAt: null });
      await db.ref(`trueConnectionDecisions/${c.id}`).remove();
      return { status: 'active' };
    }
    return { status: 'ending', waiting: true };
  });

  // Safety: immediate separation, no waiting period.
  route('/api/tc/report', async (uid, b) => {
    const c = await loadConnection(uid, b.connectionId);
    const reason = clean(b.reason, 1000);
    if (reason.length < 8) fail(400, 'Please describe what happened (at least 8 characters).');
    const other = c.userA === uid ? c.userB : c.userA;
    const rr = db.ref('trueConnectionSafetyReports').push();
    await rr.set({ id: rr.key, connectionId: c.id, reporterUid: uid, reportedUid: other, reason, category: clean(b.category, 40) || 'safety', createdAt: now(), status: 'new' });
    await db.ref(`blocks/${uid}/${other}`).set(true);
    await closeConnection(c.id, 'safety_report', uid);
    return { reportId: rr.key };
  });

  // ---------------------------------------------------------------- state (single read for the UI)
  route('/api/tc/state', async uid => {
    const [elig, user] = await Promise.all([val(`trueConnectionEligibility/${uid}`), val(`users/${uid}`)]);
    const verified = !!user && (user.verified === true || user.kycStatus === 'approved' || user.kycStatus === 'verified');
    const base = { rulesVersion: RULES_VERSION, accountVerified: verified, requireVerified: REQUIRE_VERIFIED };
    if (elig && elig.approval === 'pending' && elig.rulesVersion === RULES_VERSION) return { ...base, stage: 'pending' };
    if (elig && elig.approval === 'rejected') return { ...base, stage: 'rejected' };
    if (!elig || elig.eligible !== true || elig.rulesVersion !== RULES_VERSION) return { ...base, stage: 'join' };
    if (elig.suspended === true) return { ...base, stage: 'suspended' };

    // live connection
    let liveId = await val(`trueConnectionLive/${uid}`);
    if (liveId) {
      const c = await val(`trueConnections/${liveId}`);
      if (c && c.status === 'ending' && Number(c.endsAt || 0) <= now()) { await closeConnection(liveId, 'resolution_period_complete'); liveId = null; }
      else if (!c || c.status === 'closed') { await releaseLive(uid, liveId); liveId = null; }
      else {
        const other = c.userA === uid ? c.userB : c.userA;
        const decisions = (await val(`trueConnectionDecisions/${liveId}`)) || {};
        return { ...base, stage: 'connected', connection: { id: liveId, chatId: `tc_${liveId}`, status: c.status, endsAt: c.endsAt || null, endedBy: c.endedBy || null, otherUid: other, iContinued: decisions[uid] === 'continue', theyContinued: decisions[other] === 'continue', startedAt: c.startedAt } };
      }
    }
    const [profile, recs, outSnap, inSnap] = await Promise.all([
      val(`trueConnectionProfiles/${uid}`), val(`trueConnectionRecommendations/${uid}`),
      db.ref('trueConnectionRequests').orderByChild('fromUid').equalTo(uid).once('value'),
      db.ref('trueConnectionRequests').orderByChild('toUid').equalTo(uid).once('value')
    ]);
    const outgoing = Object.values(outSnap.val() || {}).filter(r => r.status === 'pending').map(r => ({ id: r.id, toUid: r.toUid, createdAt: r.createdAt }));
    const incoming = [];
    for (const r of Object.values(inSnap.val() || {}).filter(r => r.status === 'pending')) {
      const p = await val(`trueConnectionProfiles/${r.fromUid}`);
      if (p && (await eligibilityOf(r.fromUid))) incoming.push({ id: r.id, createdAt: r.createdAt, card: publicCard(r.fromUid, p) }); // no name before mutual acceptance
    }
    // recommendations stale if a candidate got connected/blocked since
    let candidates = [];
    if (recs && recs.candidates) {
      for (const [cu, card] of Object.entries(recs.candidates)) {
        if (await val(`trueConnectionLive/${cu}`)) continue;
        if ((await val(`blocks/${uid}/${cu}`)) === true || (await val(`blocks/${cu}/${uid}`)) === true) continue;
        candidates.push(card);
      }
    }
    return { ...base, stage: profile && profile.active === true ? 'matching' : 'profile', ageBand: elig.ageBand, profile: profile || null, mood: recs ? recs.mood : null, recommendations: candidates, recommendationsAt: recs ? recs.generatedAt : null, outgoing, incoming };
  });

  // ---------------------------------------------------------------- admin (moderation)
  app.post('/api/admin/tc/reports', async (req, res) => {
    try {
      await requireAdmin(req, 'tc:moderate');
      const s = await db.ref('trueConnectionSafetyReports').orderByChild('createdAt').limitToLast(100).once('value');
      const reports = Object.values(s.val() || {}).sort((a, b) => b.createdAt - a.createdAt);
      return res.json({ ok: true, reports });
    } catch (e) { return res.status(e.message === 'Forbidden' ? 403 : 401).json({ ok: false, error: e.message === 'Forbidden' ? 'Not allowed.' : 'Sign in again.' }); }
  });
  app.post('/api/admin/tc/resolve', async (req, res) => {
    try {
      const actor = await requireAdmin(req, 'tc:moderate');
      const { reportId, action, reason } = req.body || {};
      const rep = await val(`trueConnectionSafetyReports/${clean(reportId, 128)}`);
      if (!rep) return res.status(404).json({ ok: false, error: 'Report not found.' });
      if (!['dismiss', 'suspend_reported'].includes(action)) return res.status(400).json({ ok: false, error: 'Invalid action.' });
      const auditId = await writeAudit(actor, `tc_report_${action}`, 'trueConnectionSafetyReport', rep.id, reason, { status: rep.status }, { status: 'reviewed', action });
      const updates = { [`trueConnectionSafetyReports/${rep.id}/status`]: 'reviewed', [`trueConnectionSafetyReports/${rep.id}/reviewedBy`]: actor.uid, [`trueConnectionSafetyReports/${rep.id}/reviewedAt`]: now(), [`trueConnectionSafetyReports/${rep.id}/action`]: action, [`trueConnectionSafetyReports/${rep.id}/auditId`]: auditId };
      if (action === 'suspend_reported') {
        updates[`trueConnectionEligibility/${rep.reportedUid}/suspended`] = true;
        updates[`trueConnectionProfiles/${rep.reportedUid}/active`] = false;
        updates[`trueConnectionRecommendations/${rep.reportedUid}`] = null;
      }
      await db.ref().update(updates);
      return res.json({ ok: true });
    } catch (e) { return res.status(e.message === 'Forbidden' ? 403 : 400).json({ ok: false, error: e.message === 'Forbidden' ? 'Not allowed.' : e.message }); }
  });
};
    