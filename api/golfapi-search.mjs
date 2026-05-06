const GOLFAPI_KEY = "92d72505-a9b3-45a6-a20d-98f35961f006";
const BASE = "https://www.golfapi.io/api/v2.3";
const HEADERS = { "Authorization": `Bearer ${GOLFAPI_KEY}`, "Accept": "application/json" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const { q, debug } = req.query;
  if (!q) { res.status(400).json({ error: "Missing query" }); return; }
  try {
    const url = `${BASE}/clubs?name=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: HEADERS });
    const data = await r.json();

    // Return raw if debug mode
    if (debug === "1") { res.status(200).json({ raw: data, url, status: r.status }); return; }

    // golfapi.io returns array directly or wrapped
    const clubs = Array.isArray(data) ? data : (data.clubs || data.results || data.data || []);
    const courses = clubs.map((club) => ({
      id: club.clubID || club.id || club.club_id,
      course_name: club.clubName || club.club_name || club.name,
      club_name: club.clubName || club.club_name || club.name,
      location: {
        city: club.city || club.municipality,
        state: club.state || club.region || club.country,
        latitude: club.latitude || club.lat,
        longitude: club.longitude || club.lng || club.lon,
      },
      _raw: club,
    }));
    res.status(200).json({ courses, total: courses.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
