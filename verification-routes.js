// MudyHub Verification Centre — identity verification used as the True Connection gate.
// Files are stored in the private R2 bucket (uploaded through /api/files/* first).
// Register from server.js:
//   registerVerification({ app, admin, db, authenticatedUid, requireAdmin, writeAudit });
//
//   POST /api/verification/status                 own status (no private data)
//   POST /api/verification/submit                 { fullName, dateOfBirth, whatsapp, nin, consent, documentKey, selfieKey? }
//   POST /api/admin/verification/list             pending applications with short-lived document links
//   POST /api/admin/verification/review           { uid, decision: 'approve'|'reject', reason }
//
// Privacy: the full NIN is never stored. The server keeps an HMAC hash (for duplicate checks) and the last four digits.
// Requires env VERIFICATION_HASH_SECRET (a long random string, kept private in Render).

import crypto from "crypto";
import { presignRead, headObject } from "./r2-storage.js";

export default function registerVerification({ app, admin, db, authenticatedUid, requireAdmin, writeAudit }) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
  const now = () => Date.now();
  const val = async path => (await db.ref(path).once("value")).val();
  const reply = (res, e) => {
    const status = e.status || (e.message === "Unauthorized" ? 401 : 500);
    if (status === 500) console.error("[verification]", e);
    return res.status(status).json({ error: status === 500 ? "Something went wrong. Please try again." : e.message });
  };
  const ninHash = nin => {
    const secret = process.env.VERIFICATION_HASH_SECRET;
    if (!secret) throw fail(500, "Verification is not configured yet. Please try again later.");
    return crypto.createHmac("sha256", secret).update(nin).digest("hex");
  };
  // A file key the storage routes issued to this user: verification/{uid}/{uuid}.{ext}
  const isOwnKey = (key, uid) => new RegExp(`^verification\\/${uid}\\/[A-Za-z0-9-]{36}\\.(jpg|png|pdf)$`).test(key);

  // ---------- status ----------
  app.post("/api/verification/status", async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const a = (await val(`verificationApplications/${uid}`)) || null;
      const user = (await val(`users/${uid}`)) || {};
      return res.json({
        status: a ? a.status : "none",
        rejectionReason: a && a.status === "rejected" ? clean(a.rejectionReason, 300) : "",
        submittedAt: a ? a.submittedAt || null : null,
        canSubmit: !a || a.status === "rejected",
        identityStatus: user.identityStatus || (a ? a.status : "none")
      });
    } catch (e) { return reply(res, e); }
  });

  // ---------- submit ----------
  app.post("/api/verification/submit", async (req, res) => {
    try {
      const uid = await authenticatedUid(req);
      const authUser = await admin.auth().getUser(uid);
      if (!authUser.emailVerified) throw fail(403, "Verify your email address before submitting identity documents.");
      const user = (await val(`users/${uid}`)) || {};
      if (user.banned === true || user.status === "banned") throw fail(403, "Your account is restricted. Contact Support.");

      const existing = await val(`verificationApplications/${uid}`);
      if (existing && (existing.status === "pending" || existing.status === "approved")) {
        throw fail(409, existing.status === "approved" ? "Your identity is already verified." : "Your application is already awaiting review.");
      }

      const b = req.body || {};
      const fullName = clean(b.fullName, 100);
      const dob = clean(b.dateOfBirth, 10);
      const whatsapp = clean(b.whatsapp, 16).replace(/[^\d+]/g, "");
      const nin = clean(b.nin, 11);
      const documentKey = clean(b.documentKey, 200);
      const selfieKey = b.selfieKey ? clean(b.selfieKey, 200) : null;

      if (fullName.length < 3) throw fail(400, "Enter your full legal name.");
      const dobDate = new Date(dob);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(dobDate) || dobDate >= new Date()) throw fail(400, "Enter a valid date of birth.");
      const age = (Date.now() - dobDate.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (age < 18) throw fail(403, "Identity verification is for adults aged 18 and above.");
      if (!/^\+?\d{10,15}$/.test(whatsapp)) throw fail(400, "Enter a valid WhatsApp number.");
      if (!/^\d{11}$/.test(nin)) throw fail(400, "NIN must contain exactly 11 digits.");
      if (b.consent !== true) throw fail(400, "Please confirm your consent.");

      // The document must be a file this user uploaded through the storage routes, and it must really be there.
      if (!isOwnKey(documentKey, uid)) throw fail(400, "Upload your identity document first.");
      if (!(await headObject(documentKey))) throw fail(400, "Your identity document was not received. Please upload it again.");
      if (selfieKey) {
        if (!isOwnKey(selfieKey, uid)) throw fail(400, "Selfie upload is invalid.");
        if (!(await headObject(selfieKey))) throw fail(400, "Your selfie was not received. Please upload it again.");
      }

      // One NIN, one account.
      const hash = ninHash(nin);
      const dupes = await db.ref("verificationApplications").orderByChild("ninHash").equalTo(hash).once("value");
      const clash = Object.entries(dupes.val() || {}).some(([other, a]) => other !== uid && a && (a.status === "pending" || a.status === "approved"));
      if (clash) throw fail(409, "This NIN is already linked to another MudyHub account. Contact Support if you think this is a mistake.");

      await db.ref(`verificationApplications/${uid}`).set({
        uid, fullName, dateOfBirth: dob, whatsapp,
        ninHash: hash, ninLastFour: nin.slice(-4),
        documentKey, selfieKey,
        status: "pending", submittedAt: now(), consent: true, consentAt: now(),
        reviewType: "personal_identity", rejectionReason: "", reviewedBy: null, reviewedAt: null
      });
      await db.ref(`users/${uid}/identityStatus`).set("pending");
      return res.json({ ok: true, status: "pending" });
    } catch (e) { return reply(res, e); }
  });

  // ---------- admin: pending applications (documents are short-lived links, admins only) ----------
  app.post("/api/admin/verification/list", async (req, res) => {
    try {
      await requireAdmin(req, "verification");
      const snap = await db.ref("verificationApplications").orderByChild("status").equalTo("pending").limitToLast(50).once("value");
      const items = [];
      for (const [uid, a] of Object.entries(snap.val() || {})) {
        items.push({
          uid, fullName: clean(a.fullName, 100), dateOfBirth: a.dateOfBirth || "", whatsapp: a.whatsapp || "",
          ninLastFour: a.ninLastFour || "", submittedAt: a.submittedAt || 0,
          documentUrl: a.documentKey ? await presignRead(a.documentKey, 900) : "",
          selfieUrl: a.selfieKey ? await presignRead(a.selfieKey, 900) : ""
        });
      }
      items.sort((x, y) => (x.submittedAt || 0) - (y.submittedAt || 0));
      return res.json({ ok: true, items });
    } catch (e) { return reply(res, e); }
  });

  // ---------- admin review ----------
  app.post("/api/admin/verification/review", async (req, res) => {
    try {
      const actor = await requireAdmin(req, "verification");
      const b = req.body || {};
      const uid = clean(b.uid, 128);
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw fail(400, "Invalid applicant.");
      const reason = clean(b.reason, 300);
      if (b.decision !== "approve" && b.decision !== "reject") throw fail(400, "Decision must be approve or reject.");
      if (b.decision === "reject" && reason.length < 5) throw fail(400, "Give a clear reason for rejecting this application.");
      const app_ = await val(`verificationApplications/${uid}`);
      if (!app_) throw fail(404, "Application not found.");
      if (app_.status !== "pending") throw fail(400, "Only pending applications can be decided.");

      const t = now();
      if (b.decision === "approve") {
        await db.ref(`verificationApplications/${uid}`).update({ status: "approved", reviewedBy: actor.uid, reviewedAt: t, rejectionReason: "" });
        await db.ref(`users/${uid}`).update({ identityStatus: "approved", identityVerifiedAt: t });
        await writeAudit(actor, "identity_approve", "verification", uid, "", { status: "pending" }, { status: "approved" });
        return res.json({ ok: true, status: "approved" });
      }
      await db.ref(`verificationApplications/${uid}`).update({ status: "rejected", reviewedBy: actor.uid, reviewedAt: t, rejectionReason: reason });
      await db.ref(`users/${uid}`).update({ identityStatus: "rejected" });
      await writeAudit(actor, "identity_reject", "verification", uid, reason, { status: "pending" }, { status: "rejected" });
      return res.json({ ok: true, status: "rejected" });
    } catch (e) { return reply(res, e); }
  });
}
