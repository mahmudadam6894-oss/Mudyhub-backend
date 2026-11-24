// profile-routes.js — saves a member's own profile changes through the server.
// The server checks every value before it writes (the database rules stay as a second safety net).
// Register from server.js:  registerProfile({ app, admin, db, authenticatedUid });
//
//   POST /api/profile/update   { fullName, username, phone, country, skills, goals }
//   POST /api/profile/avatar   { dataUrl }     (JPEG or PNG, up to about 1 MB)

import { presignRead, headObject, deleteObject } from "./r2-storage.js";

const PUBLIC_API = "https://mudyhub-backend-1.onrender.com";
const USERNAME = /^[a-z0-9_]{3,24}$/;
const PHONE = /^\+?\d{10,15}$/;

export default function registerProfile({ app, admin, db, authenticatedUid }) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
    const reply = (res, e) => {
        const status = e.status || (e.message === "Unauthorized" ? 401 : 500);
        if (status === 500) console.error("[profile]", e);
        return res.status(status).json({ error: status === 500 ? "Could not save. Please try again." : e.message });
    };
    const val = async path => (await db.ref(path).once("value")).val();

    // Keeps the public copy of a member's name, username and photo up to date. Written by the server only.
    async function syncPublicProfile(uid) {
        const u = (await val(`users/${uid}`)) || {};
        await db.ref(`publicProfiles/${uid}`).update({
            uid,
            username: String(u.username || ""),
            fullName: String(u.fullName || u.fullname || ""),
            fullname: String(u.fullName || u.fullname || ""),
            avatarUrl: String(u.avatarUrl || ""),
            updatedAt: Date.now()
        });
    }

    async function activeUser(uid) {
        const authUser = await admin.auth().getUser(uid);
        const u = (await val(`users/${uid}`)) || {};
        if (u.banned === true || u.status === "banned") throw fail(403, "Your account is restricted. Contact Support.");
        return { u, email: authUser.email || "" };
    }

    app.post("/api/profile/update", async (req, res) => {
        try {
            const uid = await authenticatedUid(req);
            const { u: current } = await activeUser(uid);
            const b = req.body || {};
            const fullName = clean(b.fullName, 60);
            const username = clean(b.username, 24).toLowerCase();
            const phone = clean(b.phone, 16).replace(/\s+/g, "");
            const country = clean(b.country, 40);
            const skills = clean(b.skills, 120);
            const goals = clean(b.goals, 200);

            if (fullName.length < 3) throw fail(400, "Enter your full name (at least 3 characters).");
            if (!USERNAME.test(username)) throw fail(400, "Username must be 3–24 characters: letters, numbers or underscore.");
            if (phone && !PHONE.test(phone)) throw fail(400, "Enter a valid phone number, for example +234 800 000 0000.");

            // Usernames are unique. Reserve the new one, and release the old one.
            const oldName = clean(current.username, 24).toLowerCase();
            if (oldName !== username) {
                const taken = await val(`usernameIndex/${username}`);
                if (taken && taken !== uid) throw fail(409, "That username is already taken.");
                await db.ref(`usernameIndex/${username}`).set(uid);
                if (oldName && (await val(`usernameIndex/${oldName}`)) === uid) await db.ref(`usernameIndex/${oldName}`).remove();
            }

            const updated = { fullName, fullname: fullName, username, phone, country, skills, goals };
            await db.ref(`users/${uid}`).update(updated);
            await syncPublicProfile(uid).catch(e => console.warn("[profile] public copy:", e.message));
            return res.json({ ok: true, profile: updated });
        } catch (e) { return reply(res, e); }
    });

    // Stable link for a member's photo. It redirects to a fresh, short-lived link to the file in R2.
    // Public on purpose: profile photos are visible across the app.
    app.get("/api/avatar/:uid", async (req, res) => {
        try {
            const uid = String(req.params.uid || "");
            if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) return res.status(404).end();
            const key = await val(`users/${uid}/avatarKey`);
            if (!key) return res.status(404).end();
            const url = await presignRead(key, 300);
            res.setHeader("Cache-Control", "private, max-age=120");
            return res.redirect(302, url);
        } catch (e) { console.error("[avatar]", e.message); return res.status(404).end(); }
    });

    app.post("/api/profile/avatar", async (req, res) => {
        try {
            const uid = await authenticatedUid(req);
            await activeUser(uid);
            const b = req.body || {};
            const oldKey = await val(`users/${uid}/avatarKey`);
            if (b.key) {
                // New way: the photo is already in R2 (uploaded and confirmed by /api/files/*).
                const key = String(b.key);
                if (!new RegExp("^avatars/" + uid + "/[A-Za-z0-9-]{36}\\.(jpg|png)$").test(key)) throw fail(400, "Invalid photo.");
                if (!(await headObject(key))) throw fail(400, "The photo was not received. Please try again.");
                await db.ref(`users/${uid}`).update({ avatarKey: key, avatarUrl: `${PUBLIC_API}/api/avatar/${uid}?v=${Date.now()}`, avatarUpdatedAt: Date.now() });
                await syncPublicProfile(uid).catch(e => console.warn("[profile] public copy:", e.message));
                if (oldKey && oldKey !== key) await deleteObject(oldKey).catch(() => {});
                return res.json({ ok: true, avatarUrl: `${PUBLIC_API}/api/avatar/${uid}` });
            }
            // Fallback while storage is not set up: the photo is kept in the record, as before.
            const dataUrl = String(b.dataUrl || "");
            if (!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw fail(400, "Choose a JPEG or PNG photo.");
            if (dataUrl.length > 1400000) throw fail(400, "That photo is too large. Choose a smaller one.");
            await db.ref(`users/${uid}/avatarUrl`).set(dataUrl);
            await syncPublicProfile(uid).catch(e => console.warn("[profile] public copy:", e.message));
            return res.json({ ok: true, avatarUrl: dataUrl });
        } catch (e) { return reply(res, e); }
    });
}
