const GOLFAPI_KEY = "92d72505-a9b3-45a6-a20d-98f35961f006";
const BASE = "https://www.golfapi.io/api/v2.3";
const HEADERS = { "Authorization": `Bearer ${GOLFAPI_KEY}`, "Accept": "application/json" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const { id } = req.query;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }
  try {
    const r = await fetch(`${BASE}/clubs/${id}`, { headers: HEADERS });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
