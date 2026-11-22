import crypto from 'crypto';
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
  // V2 features (prompts, prompt-comments, first-message rule). Off unless TC_V2_ENABLED=true.
  const V2 = String(process.env.TC_V2_ENABLED || 'false') === 'true';
  const FIRST_MESSAGE_MS = 48 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DAILY_REQUEST_LIMIT = Math.max(1, Number(process.env.TC_DAILY_REQUEST_LIMIT || 5));
  const PROMPT_ANSWER_MIN = 10, PROMPT_ANSWER_MAX = 150, PROMPT_COUNT = 3;
  const PHOTO_SLOTS = 4, PHOTO_MAX_BYTES = 600 * 1024, SIGNED_URL_MS = 60 * 60 * 1000;
  const DISCOVER_DAILY_VIEWS = 60, DISCOVER_MIN_SAME_STATE = 10, DISCOVER_PAGE = 20;
  const DECLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  // Fixed list: users choose three. Ids are stored; questions come from this list only.
  const PROMPTS = {
    study_tip:    'My best study tip is',
    weekend:      'On a free weekend you will find me',
    campus_pride: 'What I love most about my school is',
    future:       'In five years I hope to be',
    skill:        'A skill I am building right now is',
    food:         'The best meal in my town is',
    music:        'The song I keep on repeat is',
    goal:         'Something I am proud of this year is'
  };

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

  // Prompt answers: 3 different prompts from the list, 10-150 characters, no contact details.
  function cleanPrompts(raw, required) {
    if (raw === undefined || raw === null) { if (required) fail(400, 'Choose your three prompts.'); return []; }
    if (!Array.isArray(raw)) fail(400, 'Prompts are not valid.');
    if (raw.length > PROMPT_COUNT) fail(400, 'Choose no more than three prompts.');
    const seen = new Set(), out = [];
    for (const item of raw) {
      const id = clean(item && item.id, 40), answer = clean(item && item.answer, PROMPT_ANSWER_MAX);
      if (!Object.prototype.hasOwnProperty.call(PROMPTS, id)) fail(400, 'Choose prompts from the list.');
      if (seen.has(id)) fail(400, 'Each prompt can only be chosen once.');
      if (answer.length < PROMPT_ANSWER_MIN) fail(400, `Each prompt answer needs at least ${PROMPT_ANSWER_MIN} characters.`);
      if (CONTACT_RE.test(answer)) fail(400, 'Do not include phone numbers, emails, links or handles in prompt answers.');
      seen.add(id); out.push({ id, question: PROMPTS[id], answer });
    }
    if (required && out.length !== PROMPT_COUNT) fail(400, `Answer exactly ${PROMPT_COUNT} prompts.`);
    return out;
  }

  // Location is stored as free text, e.g. "Kano, Kano". The state is the last part.
  const stateOf = loc => String(loc || '').split(',').pop().trim().toLowerCase();
  // Photos are private files; the app receives a link that expires after one hour.
  async function photoLinkFor(profile) {
    const first = Array.isArray(profile && profile.photos) ? [...profile.photos].sort((a, b) => a.slot - b.slot)[0] : null;
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!first || !first.path || !bucketName) return '';
    const [url] = await admin.storage().bucket(bucketName).file(first.path).getSignedUrl({ action: 'read', expires: now() + SIGNED_URL_MS });
    return url;
  }

  // Pending first-message deadline: if the accepter never writes, the connection closes.
  async function expireUnopenedConnection(c) {
    if (!c || c.status !== 'active' || c.awaitingFirstMessage !== true) return false;
    if (Number(c.firstMessageDeadline || 0) > now()) return false;
    const opened = await val(`messages/tc_${c.id}`);
    if (opened) { await db.ref(`trueConnections/${c.id}/awaitingFirstMessage`).set(false); return false; }
    await closeConnection(c.id, 'first_message_timeout');
    return true;
  }
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
    const verified = user.identityStatus === 'approved';
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
      prompts: V2 ? cleanPrompts(b.prompts, true) : [],
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
    // Keep photos that were uploaded separately; saving the text fields must not remove them.
    const prevProfile = (await val(`trueConnectionProfiles/${uid}`)) || {};
    p.photos = Array.isArray(prevProfile.photos) ? prevProfile.photos : [];
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
    communication: p.communication || 'any', prompts: Array.isArray(p.prompts) ? p.prompts : []
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
    const shown = await val(`tcDiscoverShown/${uid}/${target}`);
    if (!shown && (!recs || !recs.candidates || !recs.candidates[target])) fail(403, 'You can only approach people you were shown in Recommendations or Discover.');
    if (await val(`trueConnectionLive/${uid}`)) fail(409, 'You already have an active or resolving connection.');
    if (!(await eligibilityOf(target))) fail(409, 'This member is no longer available.');
    if (await val(`trueConnectionLive/${target}`)) fail(409, 'This member is no longer available.');
    if ((await val(`blocks/${uid}/${target}`)) === true || (await val(`blocks/${target}/${uid}`)) === true) fail(409, 'This member is no longer available.');
    const [out, inc] = await Promise.all([
      db.ref('trueConnectionRequests').orderByChild('fromUid').equalTo(uid).once('value'),
      db.ref('trueConnectionRequests').orderByChild('toUid').equalTo(target).once('value')
    ]);
    const outAll = Object.values(out.val() || {});
    const sentToday = outAll.filter(r => Number(r.createdAt || 0) > now() - DAY_MS).length;
    if (sentToday >= DAILY_REQUEST_LIMIT) fail(429, `You can send up to ${DAILY_REQUEST_LIMIT} requests in 24 hours. Try again later.`);
    let promptId = null, comment = null;
    if (V2 && b.comment !== undefined && b.comment !== null && String(b.comment).trim() !== '') {
      const tp = await val(`trueConnectionProfiles/${target}`);
      promptId = clean(b.promptId, 40);
      const hit = Array.isArray(tp && tp.prompts) && tp.prompts.find(p => p.id === promptId);
      if (!hit) fail(400, 'Comment on one of their prompt answers.');
      comment = clean(b.comment, 150);
      if (comment.length < 3) fail(400, 'Write a short comment (at least 3 characters).');
      if (CONTACT_RE.test(comment)) fail(400, 'Do not include phone numbers, emails, links or handles in comments.');
    }
    const outPending = Object.values(out.val() || {}).filter(r => r.status === 'pending');
    if (outPending.length) fail(409, 'You already have a pending request. Cancel it to approach someone else.');
    const incPending = Object.values(inc.val() || {}).filter(r => r.status === 'pending');
    if (incPending.some(r => r.fromUid === uid)) fail(409, 'Request already sent.');
    if (incPending.length >= MAX_INCOMING_PENDING) fail(409, 'This member is not available right now.');
    const rid = db.ref('trueConnectionRequests').push().key;
    await db.ref(`trueConnectionRequests/${rid}`).set({ id: rid, fromUid: uid, toUid: target, status: 'pending', createdAt: now(), ...(comment ? { promptId, comment } : {}) });
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
      const firstDeadline = t + FIRST_MESSAGE_MS;
      const opener = (V2 && r.comment) ? { promptId: r.promptId || null, comment: r.comment } : null;
      await db.ref().update({
        [`trueConnections/${connId}`]: { id: connId, userA: a, userB: bb, participants, status: 'active', startedAt: t, requestId: rid,
          ...(V2 ? { awaitingFirstMessage: true, firstMessageBy: uid, firstMessageDeadline: firstDeadline, opener } : {}) },
        [`chatMembers/tc_${connId}`]: { connectionId: connId, members: participants, userA: a, userB: bb, createdAt: t,
          ...(V2 ? { firstMessageBy: uid, firstMessageDeadline: firstDeadline } : {}) },
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
    if (await expireUnopenedConnection(c)) fail(409, 'This connection closed because the first message was not sent within 48 hours.');
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
  // ---------------------------------------------------------------- privacy: connection details
  // Only an active or resolving participant can read the other person's first name and photo.
  // The surname, date of birth, phone, email and any reports are never returned.
  route('/api/tc/connection', async (uid, b) => {
    const c = await loadConnection(uid, b.connectionId);
    if (c.status !== 'active' && c.status !== 'ending') fail(409, 'This connection is not active.');
    const other = c.userA === uid ? c.userB : c.userA;
    const u = (await val(`users/${other}`)) || {};
    const full = String(u.fullName || u.fullname || u.username || 'Member').trim();
    const firstName = (full.split(/\s+/)[0] || 'Member').slice(0, 30);
    const p = (await val(`trueConnectionProfiles/${other}`)) || {};
    let avatarUrl = clean(p.avatarUrl || '', 2000);
    if (!/^(https?:\/\/|data:image\/)/i.test(avatarUrl) || avatarUrl.length > 1500) avatarUrl = '';
    return { id: c.id, chatId: `tc_${c.id}`, otherUid: other, firstName, avatarUrl };
  });

  // ---------------------------------------------------------------- privacy: export my data
  route('/api/tc/data/export', async uid => {
    const [elig, profile, sent, received, conns] = await Promise.all([
      val(`trueConnectionEligibility/${uid}`),
      val(`trueConnectionProfiles/${uid}`),
      db.ref('trueConnectionRequests').orderByChild('fromUid').equalTo(uid).once('value'),
      db.ref('trueConnectionRequests').orderByChild('toUid').equalTo(uid).once('value'),
      db.ref('trueConnections').orderByChild('userA').equalTo(uid).once('value')
    ]);
    const mine = snap => Object.values(snap.val() || {}).map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
    const connsB = await db.ref('trueConnections').orderByChild('userB').equalTo(uid).once('value');
    const connections = [...Object.values(conns.val() || {}), ...Object.values(connsB.val() || {})]
      .map(c => ({ id: c.id, status: c.status, startedAt: c.startedAt, closedAt: c.closedAt || null, closedReason: c.closedReason || null }));
    return {
      exportedAt: now(),
      eligibility: elig ? { ageBand: elig.ageBand, approval: elig.approval, appliedAt: elig.appliedAt, rulesAcceptedAt: elig.rulesAcceptedAt } : null,
      profile: profile ? { bio: profile.bio, about: profile.about, intentions: profile.intentions, values: profile.values, interests: profile.interests, location: profile.location, communication: profile.communication, agePreference: profile.agePreference, locationPreference: profile.locationPreference, prompts: profile.prompts || [] } : null,
      requestsSent: mine(sent),
      requestsReceived: mine(received),
      connections
    };
  });

  // ---------------------------------------------------------------- privacy: delete my True Connection data
  // Removes my profile, prompts, recommendations and pending requests, and closes any open connection.
  // The other person's chat history is kept only as a closed record. A suspension is kept so it cannot be bypassed.
  route('/api/tc/data/delete', async (uid, b) => {
    if (b.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm.');
    const live = await val(`trueConnectionLive/${uid}`);
    if (live) {
      const c = await val(`trueConnections/${live}`);
      if (c && c.status !== 'closed') await closeConnection(live, 'member_deleted_data', uid);
      await releaseLive(uid, live);
    }
    await cancelPendingFor([uid], null);
    const elig = (await val(`trueConnectionEligibility/${uid}`)) || {};
    await db.ref().update({
      [`trueConnectionProfiles/${uid}`]: null,
      [`trueConnectionRecommendations/${uid}`]: null,
      [`trueConnectionEligibility/${uid}`]: { eligible: false, suspended: elig.suspended === true, dataDeletedAt: now(), approval: elig.approval || 'none' }
    });
    return { deleted: true, message: 'Your True Connection profile, prompts and pending requests were removed. Any open connection was closed.' };
  });

  // ---------------------------------------------------------------- photos (private storage, up to four)
  route('/api/tc/photos/upload', async (uid, b) => {
    await requireEligible(uid);
    const slot = Number(b.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= PHOTO_SLOTS) fail(400, 'Choose a photo slot from 1 to 4.');
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''));
    if (!m) fail(400, 'Upload a JPEG or PNG photo.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > PHOTO_MAX_BYTES) fail(400, 'That photo is too large. Use one under 600 KB.');
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) fail(500, 'Photo storage is not configured yet.');
    const existing = (await val(`trueConnectionProfiles/${uid}/photos`)) || [];
    const old = existing.find(p => p.slot === slot);
    const ext = m[1].endsWith('png') ? 'png' : 'jpg';
    const path = `tcPhotos/${uid}/${crypto.randomUUID()}.${ext}`;
    const bucket = admin.storage().bucket(bucketName);
    await bucket.file(path).save(buf, { resumable: false, contentType: m[1], metadata: { cacheControl: 'private, max-age=0' } });
    const next = existing.filter(p => p.slot !== slot).concat([{ slot, path, uploadedAt: now() }]).sort((x, y) => x.slot - y.slot);
    await db.ref(`trueConnectionProfiles/${uid}/photos`).set(next);
    if (old && old.path) await bucket.file(old.path).delete().catch(() => {});
    return { slot, count: next.length };
  });

  route('/api/tc/photos/remove', async (uid, b) => {
    await requireEligible(uid);
    const slot = Number(b.slot);
    const existing = (await val(`trueConnectionProfiles/${uid}/photos`)) || [];
    const gone = existing.find(p => p.slot === slot);
    if (!gone) fail(404, 'No photo in that slot.');
    const left = existing.filter(p => p.slot !== slot);
    await db.ref(`trueConnectionProfiles/${uid}/photos`).set(left.length ? left : null);
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (bucketName && gone.path) await admin.storage().bucket(bucketName).file(gone.path).delete().catch(() => {});
    return { count: left.length };
  });

  // ---------------------------------------------------------------- Discover (browse, curated)
  // Shows verified-eligible members with a photo, prompts and an active profile.
  // Same state first; nationwide only when the state pool is small, and labelled as outside your state.
  route('/api/tc/discover', async (uid, b) => {
    await requireEligible(uid);
    const me = await val(`trueConnectionProfiles/${uid}`);
    if (!me || me.active === false) fail(409, 'Save your profile before using Discover.');
    if (!Array.isArray(me.photos) || !me.photos.length) fail(409, 'Add at least one photo before using Discover.');
    const day = new Date().toISOString().slice(0, 10);
    const used = Number((await val(`tcDiscoverViews/${uid}/${day}`)) || 0);
    if (used >= DISCOVER_DAILY_VIEWS) fail(429, "You have reached today's Discover limit. It resets tomorrow.");

    const myState = stateOf(me.location);
    const allProfiles = (await val('trueConnectionProfiles')) || {};
    const allElig = (await val('trueConnectionEligibility')) || {};
    const myBlocks = (await val(`blocks/${uid}`)) || {};
    const cutoff = now() - DECLINE_WINDOW_MS;

    const pool = [];
    for (const [other, p] of Object.entries(allProfiles)) {
      if (!p || other === uid || p.active === false) continue;
      if (!Array.isArray(p.photos) || !p.photos.length) continue;
      if (!Array.isArray(p.prompts) || !p.prompts.length) continue;
      const e = allElig[other];
      if (!e || e.eligible !== true || e.suspended === true || e.approval === 'rejected') continue;
      if (myBlocks[other] === true) continue;
      if (!b.nationwide && stateOf(p.location) !== myState) continue;
      pool.push({ other, p });
    }

    // Widen to nationwide only when the local pool is small (or the member asked for it).
    let rows = pool;
    let widened = false;
    const sameState = pool.filter(x => stateOf(x.p.location) === myState);
    if (b.nationwide === true || sameState.length < DISCOVER_MIN_SAME_STATE) {
      if (!b.nationwide) {
        widened = true;
        for (const [other, p] of Object.entries(allProfiles)) {
          if (!p || other === uid || p.active === false || stateOf(p.location) === myState) continue;
          if (!Array.isArray(p.photos) || !p.photos.length || !Array.isArray(p.prompts) || !p.prompts.length) continue;
          const e = allElig[other];
          if (!e || e.eligible !== true || e.suspended === true || e.approval === 'rejected') continue;
          if (myBlocks[other] === true) continue;
          rows.push({ other, p });
        }
      }
    }

    const scored = [];
    for (const { other, p } of rows) {
      if ((await val(`blocks/${other}/${uid}`)) === true) continue;
      const dec = Number((await val(`trueConnectionDeclines/${pairKey(uid, other)}`)) || 0);
      if (dec && dec > cutoff) continue;
      const score = overlap(split(me.interests), split(p.interests)) * 3
        + overlap(split(me.values), split(p.values)) * 4
        + overlap(split(me.intentions), split(p.intentions)) * 2
        + (stateOf(p.location) === myState ? 2 : 0)
        + (me.agePreference === 'any' || me.agePreference === p.ageBand ? 1 : 0);
      scored.push({ other, p, score, outsideState: stateOf(p.location) !== myState });
    }
    scored.sort((a, b2) => b2.score - a.score);
    const page = scored.slice(0, Math.min(DISCOVER_PAGE, DISCOVER_DAILY_VIEWS - used));

    const cards = [];
    for (const { other, p, outsideState } of page) {
      await db.ref(`tcDiscoverShown/${uid}/${other}`).set(now());
      cards.push({
        uid: other,
        photoUrl: await photoLinkFor(p),
        bio: clean(p.bio, 160),
        about: clean(p.about, 300),
        ageBand: p.ageBand || '',
        state: stateOf(p.location),
        outsideState,
        communication: p.communication || 'any',
        interests: clean(p.interests, 160),
        values: clean(p.values, 160),
        intentions: clean(p.intentions, 160),
        prompts: (p.prompts || []).map(x => ({ id: x.id, question: x.question, answer: x.answer }))
      });
    }
    if (cards.length) await db.ref(`tcDiscoverViews/${uid}/${day}`).set(used + cards.length);
    return { cards, widened, sameStatePool: sameState.length, remainingToday: Math.max(0, DISCOVER_DAILY_VIEWS - used - cards.length) };
  });

  route('/api/tc/state', async uid => {
    const [elig, user] = await Promise.all([val(`trueConnectionEligibility/${uid}`), val(`users/${uid}`)]);
    const verified = !!user && user.identityStatus === 'approved';
    const base = { rulesVersion: RULES_VERSION, accountVerified: verified, requireVerified: REQUIRE_VERIFIED, identityStatus: user.identityStatus || 'none' };
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
        if (await expireUnopenedConnection(c)) { liveId = null; return { ...base, stage: 'join' }; }
        const other = c.userA === uid ? c.userB : c.userA;
        const decisions = (await val(`trueConnectionDecisions/${liveId}`)) || {};
        return { ...base, stage: 'connected', connection: { id: liveId, chatId: `tc_${liveId}`, awaitingFirstMessage: c.awaitingFirstMessage === true, firstMessageBy: c.firstMessageBy || null, firstMessageDeadline: c.firstMessageDeadline || null, opener: c.opener || null, status: c.status, endsAt: c.endsAt || null, endedBy: c.endedBy || null, otherUid: other, iContinued: decisions[uid] === 'continue', theyContinued: decisions[other] === 'continue', startedAt: c.startedAt } };
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
      if (p && (await eligibilityOf(r.fromUid))) incoming.push({ id: r.id, createdAt: r.createdAt, card: publicCard(r.fromUid, p), ...(r.comment ? { comment: r.comment, promptQuestion: PROMPTS[r.promptId] || '' } : {}) }); // no name before mutual acceptance
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
    