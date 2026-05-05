export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const { id } = req.query;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }
  try {
    const r = await fetch(`https://api.golfcourseapi.com/v1/courses/${id}`, {
      headers: { Authorization: "Key YAHGWRREYXYA2FRGMXT2L7WSIA" },
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
