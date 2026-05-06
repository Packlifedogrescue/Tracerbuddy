const GOLFAPI_KEY = "92d72505-a9b3-45a6-a20d-98f35961f006";
const BASE = "https://www.golfapi.io/api/v2.3";
const HEADERS = { "Authorization": `Bearer ${GOLFAPI_KEY}`, "Accept": "application/json" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const { q } = req.query;
  if (!q) { res.status(400).json({ error: "Missing query" }); return; }
  try {
    const r = await fetch(`${BASE}/clubs?name=${encodeURIComponent(q)}`, { headers: HEADERS });
    const data = await r.json();
    // Normalize to expected format
    const clubs = data.clubs || data.results || (Array.isArray(data) ? data : []);
    const courses = clubs.map((club) => ({
      id: club.clubID || club.id,
      course_name: club.clubName || club.name,
      club_name: club.clubName || club.name,
      location: {
        city: club.city,
        state: club.state || club.region,
        latitude: club.latitude || club.lat,
        longitude: club.longitude || club.lng,
      },
      _raw: club,
    }));
    res.status(200).json({ courses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
