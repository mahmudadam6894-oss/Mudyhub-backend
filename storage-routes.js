// storage-routes.js — upload and view links for private files stored in R2.
// Register from server.js:  registerStorage({ app, admin, db, authenticatedUid, requireAdmin });
//
//   POST /api/files/upload-link   { purpose, contentType, size }   -> { uploadUrl, key, expiresIn, maxBytes }
//   POST /api/files/confirm       { key, purpose }                  -> checks the uploaded file, returns { key, size }
//   POST /api/files/read-link     { key }                           -> { url, expiresIn } (owner, or admin for verification)
//   POST /api/files/delete        { key }                           -> owner only
//
// Feature routes (verification, True Connection, status, posts) save the returned key in the database
// and call presignRead() themselves after their own permission checks.

import crypto from "crypto";
import { r2Configured, presignUpload, presignRead, headObject, deleteObject } from "./r2-storage.js";

const MB = 1024 * 1024;
const RULES = {
    "verification-doc":    { prefix: "verification", types: ["image/jpeg", "image/png", "application/pdf"], max: 5 * MB,   adminPerm: "verification" },
    "verification-selfie": { prefix: "verification", types: ["image/jpeg", "image/png"],                    max: 5 * MB,   adminPerm: "verification" },
    "tc-photo":            { prefix: "tc-photos",    types: ["image/jpeg", "image/png"],                    max: 600 * 1024 },
    "status-image":        { prefix: "status",       types: ["image/jpeg"],                                 max: 6 * MB },
    "status-video":        { prefix: "status",       types: ["video/mp4", "video/webm"],                    max: 4 * MB },
    "status-audio":        { prefix: "status",       types: ["audio/webm", "audio/mp4", "audio/ogg"],       max: 2.5 * MB },
    "post-media":          { prefix: "posts",        types: ["image/jpeg", "video/mp4", "video/webm"],      max: 7 * MB }
};
const EXT = {
    "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf",
    "video/mp4": "mp4", "video/webm": "webm", "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg"
};
const SAFE_KEY = /^[a-z-]+\/[A-Za-z0-9_-]{6,128}\/[A-Za-z0-9-]{36}\.[a-z0-9]{2,4}$/;

export default function registerStorage({ app, admin, db, authenticatedUid, requireAdmin }) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    const reply = (res, e) => {
        const status = e.status || (e.message === "Unauthorized" ? 401 : 500);
        if (status === 500) console.error("[storage]", e);
        return res.status(status).json({ error: status === 500 ? "Something went wrong. Please try again." : e.message });
    };
    const ownerOf = key => (key.split("/")[1] || "");

    // Signed-in, verified, not banned.
    async function activeUser(uid) {
        const authUser = await admin.auth().getUser(uid);
        if (!authUser.emailVerified) throw fail(403, "Verify your email address first.");
        const u = (await db.ref(`users/${uid}`).once("value")).val() || {};
        if (u.banned === true || u.status === "banned" || u.walletFrozen === true) throw fail(403, "Your account is restricted.");
        return u;
    }
    async function adminCan(req, perm) {
        try { await requireAdmin(req, perm); return true; } catch (e) { return false; }
    }
    const checkConfigured = () => { if (!r2Configured()) throw fail(503, "File storage is not configured yet."); };

    // ---------- 1. upload link ----------
    app.post("/api/files/upload-link", async (req, res) => {
        try {
            checkConfigured();
            const uid = await authenticatedUid(req);
            await activeUser(uid);
            const b = req.body || {};
            const rule = RULES[String(b.purpose || "")];
            if (!rule) throw fail(400, "Unknown upload type.");
            const contentType = String(b.contentType || "");
            if (!rule.types.includes(contentType)) throw fail(400, "That file type is not allowed here.");
            const size = Number(b.size);
            if (!Number.isFinite(size) || size <= 0 || size > rule.max) throw fail(400, "That file is too large for this upload.");
            const key = `${rule.prefix}/${uid}/${crypto.randomUUID()}.${EXT[contentType]}`;
            const uploadUrl = await presignUpload(key, contentType, 300);
            return res.json({ ok: true, uploadUrl, key, expiresIn: 300, maxBytes: rule.max });
        } catch (e) { return reply(res, e); }
    });

    // ---------- 2. confirm the upload really happened and matches the rules ----------
    app.post("/api/files/confirm", async (req, res) => {
        try {
            checkConfigured();
            const uid = await authenticatedUid(req);
            const key = String((req.body || {}).key || "");
            const purpose = String((req.body || {}).purpose || "");
            const rule = RULES[purpose];
            if (!rule || !SAFE_KEY.test(key) || ownerOf(key) !== uid || !key.startsWith(rule.prefix + "/")) {
                throw fail(400, "Invalid upload.");
            }
            const info = await headObject(key);
            if (!info) throw fail(404, "The upload was not received. Please try again.");
            if (info.size > rule.max || !rule.types.includes(info.contentType)) {
                await deleteObject(key).catch(() => {});
                throw fail(400, "The uploaded file does not match the allowed type or size.");
            }
            return res.json({ ok: true, key, size: info.size });
        } catch (e) { return reply(res, e); }
    });

    // ---------- 3. view link ----------
    app.post("/api/files/read-link", async (req, res) => {
        try {
            checkConfigured();
            const uid = await authenticatedUid(req);
            const key = String((req.body || {}).key || "");
            if (!SAFE_KEY.test(key)) throw fail(400, "Invalid file.");
            const prefix = key.split("/")[0];
            const isVerification = prefix === "verification";
            const allowed = ownerOf(key) === uid || (isVerification && await adminCan(req, "verification"));
            if (!allowed) throw fail(403, "You cannot open this file.");
            const url = await presignRead(key, 300);
            return res.json({ ok: true, url, expiresIn: 300 });
        } catch (e) { return reply(res, e); }
    });

    // ---------- 4. delete (owner only) ----------
    app.post("/api/files/delete", async (req, res) => {
        try {
            checkConfigured();
            const uid = await authenticatedUid(req);
            const key = String((req.body || {}).key || "");
            if (!SAFE_KEY.test(key) || ownerOf(key) !== uid) throw fail(403, "You cannot delete this file.");
            await deleteObject(key);
            return res.json({ ok: true });
        } catch (e) { return reply(res, e); }
    });
}
