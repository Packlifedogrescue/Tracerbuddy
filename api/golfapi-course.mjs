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
    // First get club to find course IDs
    const clubRes = await fetch(`${BASE}/clubs/${id}`, { headers: HEADERS });
    const clubData = await clubRes.json();
    
    // Get first course ID from club
    const courses = clubData.courses || clubData.club?.courses || [];
    const courseId = courses[0]?.courseID || courses[0]?.id || id;
    
    // Fetch course data and coordinates in parallel
    const [courseRes, coordRes] = await Promise.all([
      fetch(`${BASE}/courses/${courseId}`, { headers: HEADERS }),
      fetch(`${BASE}/coordinates/${courseId}`, { headers: HEADERS }),
    ]);
    
    const courseData = await courseRes.json();
    const coordData = await coordRes.json();
    
    res.status(200).json({ club: clubData, course: courseData, coordinates: coordData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
