module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  const { q } = req.query;
  if (!q) { res.status(400).json({ error: "Missing query" }); return; }
  try {
    const r = await fetch(`https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent(q)}`, {
      headers: { Authorization: "Key YAHGWRREYXYA2FRGMXT2L7WSIA" },
    });
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
