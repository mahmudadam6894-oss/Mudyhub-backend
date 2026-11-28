// football-routes.js — Football Zone (option 1: fixtures and official "where to watch" links only).
// Register from server.js:  registerFootball({ app, db, authenticatedUid });
//
//   POST /api/football/fixtures      { date: "YYYY-MM-DD" }  -> { date, matches: [...] }   (cached 10 minutes)
//   POST /api/football/broadcasters  { league: "Premier League" } -> { league, options: [...] }
//
// Needs env FOOTBALL_API_KEY (API-Football key, kept on Render, never in the app).
// Broadcasters are verified by the MudyHub team and stored in football/broadcasters/{league_key}.

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();   // date -> { at, matches }

const DAY = 24 * 60 * 60 * 1000;
const isoDate = t => new Date(t).toISOString().slice(0, 10);
const leagueKey = name => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);

export default function registerFootball({ app, db, authenticatedUid }) {
    const fail = (status, message) => Object.assign(new Error(message), { status });

    app.post("/api/football/fixtures", async (req, res) => {
        try {
            await authenticatedUid(req);
            const date = String((req.body || {}).date || isoDate(Date.now()));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, "Choose a valid date.");
            // Only today and the next two days.
            const today = isoDate(Date.now());
            const max = isoDate(Date.now() + 2 * DAY);
            if (date < today || date > max) throw fail(400, "You can view matches for today and the next two days.");

            const hit = cache.get(date);
            if (hit && Date.now() - hit.at < CACHE_MS) return res.json({ ok: true, date, matches: hit.matches, cached: true });

            const key = process.env.FOOTBALL_API_KEY;
            if (!key) throw fail(503, "Football fixtures are not set up yet. Please check back soon.");

            const url = `https://v3.football.api-sports.io/fixtures?date=${date}&timezone=Africa/Lagos`;
            const upstream = await fetch(url, { headers: { "x-apisports-key": key } });
            if (!upstream.ok) throw fail(502, "Fixtures are unavailable right now. Please try again later.");
            const body = await upstream.json().catch(() => ({}));
            if (body.errors && Object.keys(body.errors).length) throw fail(502, "Fixtures are unavailable right now. Please try again later.");

            const matches = (body.response || []).map(f => ({
                id: f.fixture && f.fixture.id,
                kickoff: f.fixture && f.fixture.date,
                status: (f.fixture && f.fixture.status && f.fixture.status.short) || "NS",
                minute: (f.fixture && f.fixture.status && f.fixture.status.elapsed) || null,
                league: (f.league && f.league.name) || "",
                country: (f.league && f.league.country) || "",
                leagueLogo: (f.league && f.league.logo) || "",
                home: { name: (f.teams && f.teams.home && f.teams.home.name) || "", logo: (f.teams && f.teams.home && f.teams.home.logo) || "" },
                away: { name: (f.teams && f.teams.away && f.teams.away.name) || "", logo: (f.teams && f.teams.away && f.teams.away.logo) || "" },
                homeGoals: f.goals ? f.goals.home : null,
                awayGoals: f.goals ? f.goals.away : null
            })).sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));

            cache.set(date, { at: Date.now(), matches });
            return res.json({ ok: true, date, matches, cached: false });
        } catch (e) {
            if (!e.status) console.error("[football]", e.message);
            return res.status(e.status || 500).json({ error: e.status ? e.message : "Fixtures could not load. Please try again." });
        }
    });

    // Official broadcasters for a competition. Only entries the MudyHub team has verified are shown.
    app.post("/api/football/broadcasters", async (req, res) => {
        try {
            await authenticatedUid(req);
            const league = String((req.body || {}).league || "").slice(0, 80);
            const key = leagueKey(league);
            if (!key) throw fail(400, "Choose a competition.");
            const snap = await db.ref(`football/broadcasters/${key}`).once("value");
            const raw = snap.val() || {};
            const options = Object.values(raw)
                .filter(o => o && o.verified === true && typeof o.url === "string" && /^https:\/\//.test(o.url))
                .map(o => ({
                    provider: String(o.provider || "").slice(0, 80),
                    country: String(o.country || "").slice(0, 60),
                    type: String(o.type || "TV").slice(0, 20),
                    subscription: o.subscription === true,
                    url: o.url,
                    verifiedAt: Number(o.verifiedAt || 0)
                }));
            return res.json({ ok: true, league, options });
        } catch (e) {
            if (!e.status) console.error("[football]", e.message);
            return res.status(e.status || 500).json({ error: e.status ? e.message : "Broadcasters could not load." });
        }
    });
}
