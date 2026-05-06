import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

async function apiSearchCourses(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function apiFetchCourse(id) {
  const k = `tracerbuddy_course_${id}`;
  const cached = localStorage.getItem(k);
  if (cached) return JSON.parse(cached);
  const res = await fetch(`/api/course?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  localStorage.setItem(k, JSON.stringify(data));
  return data;
}

async function fetchWeatherAndElevation(lat, lng) {
  const [wr, er] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=weather_code,wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=mph&temperature_unit=fahrenheit&forecast_days=1`),
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`),
  ]);
  const w = await wr.json();
  const e = await er.json();
  const c = w.current || {};
  return {
    windSpeed: Math.round(c.wind_speed_10m || 0),
    windDir: Math.round(c.wind_direction_10m || 0),
    tempF: Math.round(c.temperature_2m || 70),
    weatherCode: c.weather_code || 0,
    elevationFt: Math.round((e.elevation?.[0] || 0) * 3.28084),
  };
}

function weatherLabel(code) {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly Cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 65) return "Rain";
  return "Stormy";
}

function windDirLabel(deg) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function extractGreen(hole) {
  if (!hole) return null;
  const g = hole.green_location || hole.greenLocation || hole.pin_location || hole.green || null;
  if (!g) return null;
  const lat = g.lat != null ? g.lat : g.latitude != null ? g.latitude : null;
  const lng = g.lng != null ? g.lng : g.lon != null ? g.lon : g.longitude != null ? g.longitude : null;
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function extractPar(hole) {
  if (!hole) return 4;
  return hole.par || hole.hole_par || hole.Par || 4;
}

function extractHoles(data) {
  if (!data) return [];
  const root = data.course || data;
  return root.holes || root.Holes || [];
}

function extractCourseName(r) {
  if (!r) return "Unknown Course";
  return r.course_name || r.club_name || r.name || r.courseName || "Unknown Course";
}

// Leaflet icon fix
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const CLUBS = ["Driver","3 Wood","Hybrid","4 Iron","5 Iron","6 Iron","7 Iron","8 Iron","9 Iron","PW","SW","Putter"];
const SHOT_SHAPES = ["Straight","Fade","Draw","Slice","Hook","Punch","Chip","Putt"];
const LIES = ["Tee","Fairway","Rough","Sand","Recovery","Green"];
const RESULTS = ["Good","Left","Right","Short","Long","Lost","Penalty"];
const HOLES = Array.from({ length: 18 }, (_, i) => i + 1);
const DEFAULT_CLUB_DIST = { "Driver":230,"3 Wood":210,"Hybrid":190,"4 Iron":175,"5 Iron":165,"6 Iron":155,"7 Iron":145,"8 Iron":135,"9 Iron":125,"PW":110,"SW":85,"Putter":15 };
const MIN_SHOTS = 3;
const BLANK_SCORE = { par: 4, strokes: "", putts: "", penalties: 0, fir: null, gir: null, note: "" };
const GREEN = "#15803d";
const AMBER = "#b45309";
const AMBER_LIGHT = "#fef3c7";
const AMBER_BORDER = "#fcd34d";

function makeStartIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:26px;height:26px;border-radius:50%;background:#15803d;color:white;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 4px 8px rgba(0,0,0,.25);">S</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

function makeEndIcon(n) {
  return L.divIcon({
    className: "",
    html: `<div style="width:26px;height:26px;border-radius:50%;background:#b45309;color:white;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 4px 8px rgba(0,0,0,.25);">${n}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

function makeGreenIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:50%;background:#15803d;color:white;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 4px 8px rgba(0,0,0,.25);">⛳</div>`,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
}

function yardsBetween(a, b) {
  if (!a || !b) return 0;
  const R = 6371e3;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) * 1.09361);
}

function bearingTo(a, b) {
  const dL = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const y = Math.sin(dL) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dL);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function windAdj(speed, dir, bearing) {
  const toward = (dir + 180) % 360;
  const angle = (bearing - toward) * Math.PI / 180;
  const comp = speed * Math.cos(angle);
  return Math.round(comp > 0 ? comp : comp * 0.7);
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("GPS not supported")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), time: new Date().toISOString() }),
      reject,
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

function fmtTime(v) {
  try { return new Date(v).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

function fmtDate(v) {
  return new Date(v).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function cycleGir(cur) {
  if (cur === null) return true;
  if (cur === true) return false;
  return null;
}

function exportCSV(shots) {
  const hdr = ["Date","Hole","Club","Distance","Shape","Lie","Result","Note"];
  const rows = shots.map((s) => [fmtDate(s.finishedAt || s.startedAt), s.hole, s.club, s.distance, s.shotShape, s.lie, s.result, (s.note || "").replace(/"/g, "'")]);
  const csv = [hdr, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tracerbuddy-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function MapClickHandler({ onMapClick, enabled }) {
  useMapEvents({
    click(e) {
      if (enabled) onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function makePinSetIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:32px;height:32px;border-radius:50%;background:#15803d;color:white;display:flex;align-items:center;justify-content:center;font-size:16px;border:2px solid white;box-shadow:0 4px 12px rgba(0,0,0,.3);">⛳</div>`,
    iconSize: [32, 32], iconAnchor: [16, 16],
  });
}({ center, zoom = 17, enabled = true }) {
  const map = useMap();
  useEffect(() => { if (center && enabled) map.setView(center, zoom, { animate: true }); }, [center, zoom, map, enabled]);
  return null;
}

function FitBounds({ shots, currentShot, enabled = true }) {
  const map = useMap();
  useEffect(() => {
    if (!enabled) return;
    const points = [];
    if (currentShot?.start) points.push([currentShot.start.lat, currentShot.start.lng]);
    shots.forEach((s) => {
      if (s.start) points.push([s.start.lat, s.start.lng]);
      if (s.end) points.push([s.end.lat, s.end.lng]);
    });
    if (points.length >= 2) map.fitBounds(points, { padding: [40, 40], maxZoom: 18 });
  }, [shots, currentShot, enabled, map]);
  return null;
}

// ── UI components ──────────────────────────────────────────────────────────────
function Card({ children, className = "" }) {
  return (
    <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }} className={className}>
      {children}
    </div>
  );
}

function Pill({ active, children, onClick, color = "green", suggested = false }) {
  let bg, fg;
  if (active) {
    if (color === "green") { bg = GREEN; fg = "white"; }
    else if (color === "amber") { bg = AMBER; fg = "white"; }
    else { bg = "#374151"; fg = "white"; }
  } else if (suggested) {
    bg = "#f0fdf4"; fg = GREEN;
  } else {
    bg = "#f3f4f6"; fg = "#374151";
  }
  return (
    <button
      onClick={onClick}
      style={{ position: "relative", background: bg, color: fg, borderRadius: 12, padding: "8px 4px", fontSize: 11, fontWeight: 900, border: suggested && !active ? `1px solid #bbf7d0` : "1px solid transparent", transition: "transform 0.1s" }}
    >
      {suggested && !active && <span style={{ position: "absolute", top: -5, right: -4, background: GREEN, color: "white", fontSize: 8, fontWeight: 900, borderRadius: 999, padding: "1px 4px" }}>★</span>}
      {children}
    </button>
  );
}

function Tab({ active, icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{ borderRadius: 10, padding: "6px 4px", fontSize: 9, fontWeight: 900, background: active ? GREEN : "transparent", color: active ? "white" : "#9ca3af" }}
    >
      {icon} {label}
    </button>
  );
}

function Stat({ label, value, sub = "" }) {
  return (
    <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, padding: 12 }}>
      <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 900, color: "#111827", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Sparkline({ data, color = AMBER, height = 56, invert = false }) {
  if (!data || data.length < 2) return <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#9ca3af" }}>Not enough data yet</div>;
  const W = 300, H = height;
  const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1, pad = 6;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (W - pad * 2) + pad;
    const norm = invert ? 1 - (v - mn) / rng : (v - mn) / rng;
    return [x, H - pad - norm * (H - pad * 2)];
  });
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height }} preserveAspectRatio="none">
      <polyline points={points.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map(([px, py], i) => <circle key={i} cx={px} cy={py} r="3" fill={color} />)}
      <circle cx={last[0]} cy={last[1]} r="5" fill={color} />
    </svg>
  );
}

// ── Course Search ──────────────────────────────────────────────────────────────
function CourseSearch({ onSelect, selected }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function search() {
    if (!query.trim()) return;
    setLoading(true); setErr(""); setResults([]);
    try {
      const d = await apiSearchCourses(query.trim());
      const list = d.courses || d.results || [];
      setResults(list.slice(0, 6));
      if (!list.length) setErr("No courses found.");
    } catch { setErr("Search failed."); }
    finally { setLoading(false); }
  }

  async function pick(r) {
    const id = r.id || r.course_id || r.courseId;
    setLoading(true); setErr("");
    try {
      if (id) { const d = await apiFetchCourse(id); onSelect({ raw: r, holes: extractHoles(d) }); }
      else { onSelect({ raw: r, holes: [] }); }
      setResults([]); setQuery("");
    } catch { setErr("Could not load course."); }
    finally { setLoading(false); }
  }

  if (selected) {
    return (
      <div style={{ background: "#f0fdf4", border: `1px solid #bbf7d0`, borderRadius: 16, padding: "14px 16px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 900, color: GREEN, textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 2 }}>Course Loaded ✓</div>
          <div style={{ fontSize: 15, fontWeight: 900, color: "#111827" }}>{extractCourseName(selected.raw)}</div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>{selected.holes.length > 0 ? `${selected.holes.length} holes · GPS active` : "Loaded"}</div>
        </div>
        <button onClick={() => onSelect(null)} style={{ background: "#f3f4f6", border: "none", borderRadius: 10, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: "#374151", cursor: "pointer" }}>Change</button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 10, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.18em", marginBottom: 8 }}>Find Your Course (Optional)</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="e.g. Carlisle Country Club"
          style={{ flex: 1, background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "12px 16px", fontSize: 14, color: "#111827", outline: "none" }}
        />
        <button onClick={search} disabled={loading} style={{ width: 48, height: 48, background: GREEN, border: "none", borderRadius: 14, fontSize: 18, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>🔍</button>
      </div>
      {err && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>{err}</div>}
      {results.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {results.map((r, i) => (
            <button key={r.id || i} onClick={() => pick(r)} style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "12px 14px", textAlign: "left", cursor: "pointer" }}>
              <div style={{ fontSize: 14, fontWeight: 900, color: "#111827" }}>{extractCourseName(r)}</div>
              <div style={{ fontSize: 12, color: "#9ca3af" }}>{r.location?.city ? `${r.location.city}, ` : ""}{r.location?.state || r.city || ""}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Auto-detect nearby course ──────────────────────────────────────────────────
async function detectNearbyCourse(lat, lng) {
  const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=12`, {
    headers: { "Accept-Language": "en", "User-Agent": "TracerBuddy/1.0" },
  });
  const geo = await geoRes.json();
  const addr = geo.address || {};
  const city = addr.city || addr.town || addr.village || addr.county || "";
  const state = addr.state || "";
  const q = [city, state].filter(Boolean).join(" ").trim();
  if (!q) throw new Error("No location");
  const d = await apiSearchCourses(q);
  const courses = d.courses || d.results || [];
  if (!courses.length) throw new Error("None found");
  const withDist = courses.map((c) => {
    const cLat = parseFloat(c.location?.latitude || c.latitude || 0);
    const cLng = parseFloat(c.location?.longitude || c.longitude || 0);
    if (!cLat || !cLng) return { ...c, distMi: 999 };
    return { ...c, distMi: Math.round((yardsBetween({ lat, lng }, { lat: cLat, lng: cLng }) / 1760) * 10) / 10 };
  }).sort((a, b) => a.distMi - b.distMi);
  const nearest = withDist[0];
  if (nearest.distMi > 3) throw new Error("Too far");
  return nearest;
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState("track");
  const [club, setClub] = useState("Driver");
  const [shape, setShape] = useState("Straight");
  const [lie, setLie] = useState("Tee");
  const [result, setResult] = useState("Good");
  const [note, setNote] = useState("");
  const [currentShot, setCurrentShot] = useState(null);
  const [shots, setShots] = useState([]);
  const [scores, setScores] = useState(() => Object.fromEntries(HOLES.map((h) => [h, { ...BLANK_SCORE }])));
  const [status, setStatus] = useState("Ready when you are.");
  const [loading, setLoading] = useState(false);
  const [hole, setHole] = useState(1);
  const [mapMode, setMapMode] = useState("hole");
  const [autoFit, setAutoFit] = useState(true);
  const [course, setCourse] = useState(null);
  const [livePos, setLivePos] = useState(null);
  const [allShots, setAllShots] = useState([]);
  const [history, setHistory] = useState([]);
  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [shareRound, setShareRound] = useState(null);
  const [online, setOnline] = useState(true);
  const [detect, setDetect] = useState({ state: "idle", course: null });
  const [splash, setSplash] = useState(true);
  const [splashOut, setSplashOut] = useState(false);
  const [pinDist, setPinDist] = useState(null);
  const [pinDistKey, setPinDistKey] = useState(0);
  const [manualPin, setManualPin] = useState({});
  const [pinSetMode, setPinSetMode] = useState(false);
  const pinAnimRef = useRef(null);
  const watchRef = useRef(null);

  // Splash
  useEffect(() => {
    const t = setTimeout(() => { setSplashOut(true); setTimeout(() => setSplash(false), 500); }, 2200);
    return () => clearTimeout(t);
  }, []);

  // Restore
  useEffect(() => {
    try {
      const s = localStorage.getItem("tb_shots"); if (s) setShots(JSON.parse(s));
      const sc = localStorage.getItem("tb_scores"); if (sc) { const p = JSON.parse(sc); setScores(Object.fromEntries(HOLES.map((h) => [h, { ...BLANK_SCORE, ...(p[h] || {}) }]))); }
      const r = localStorage.getItem("tb_started"); if (r === "true") setStarted(true);
      const h = localStorage.getItem("tb_hole"); if (h) setHole(Number(h));
      const c = localStorage.getItem("tb_course"); if (c) setCourse(JSON.parse(c));
      const a = localStorage.getItem("tb_allshots"); if (a) setAllShots(JSON.parse(a));
      const hi = localStorage.getItem("tb_history"); if (hi) setHistory(JSON.parse(hi));
    } catch {}
  }, []);

  useEffect(() => { try { localStorage.setItem("tb_shots", JSON.stringify(shots)); } catch {} }, [shots]);
  useEffect(() => { try { localStorage.setItem("tb_scores", JSON.stringify(scores)); } catch {} }, [scores]);
  useEffect(() => { try { localStorage.setItem("tb_started", String(started)); localStorage.setItem("tb_hole", String(hole)); } catch {} }, [started, hole]);
  useEffect(() => { try { if (course) localStorage.setItem("tb_course", JSON.stringify(course)); else localStorage.removeItem("tb_course"); } catch {} }, [course]);
  useEffect(() => { try { localStorage.setItem("tb_allshots", JSON.stringify(allShots)); } catch {} }, [allShots]);
  useEffect(() => { try { localStorage.setItem("tb_history", JSON.stringify(history)); } catch {} }, [history]);

  // Online
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // Weather
  useEffect(() => {
    if (started || !navigator.geolocation) return;
    const cached = localStorage.getItem("tb_weather");
    if (cached) { try { const p = JSON.parse(cached); if (Date.now() - p.cachedAt < 7200000) { setWeather(p); return; } } catch {} }
    setWeatherLoading(true);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { const d = await fetchWeatherAndElevation(pos.coords.latitude, pos.coords.longitude); setWeather(d); localStorage.setItem("tb_weather", JSON.stringify({ ...d, cachedAt: Date.now() })); }
      catch { try { const fb = localStorage.getItem("tb_weather"); if (fb) setWeather(JSON.parse(fb)); } catch {} }
      finally { setWeatherLoading(false); }
    }, () => setWeatherLoading(false), { enableHighAccuracy: false, timeout: 8000 });
  }, [started]);

  // Auto-detect
  useEffect(() => {
    if (started || course || detect.state !== "idle" || !navigator.geolocation) return;
    setDetect({ state: "detecting", course: null });
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { const c = await detectNearbyCourse(pos.coords.latitude, pos.coords.longitude); setDetect({ state: "found", course: c }); }
      catch { setDetect({ state: "idle", course: null }); }
    }, () => setDetect({ state: "idle", course: null }), { enableHighAccuracy: false, timeout: 10000 });
  }, [started, course, detect.state]);

  // Live GPS watch
  useEffect(() => {
    if (!started || !navigator.geolocation) return;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => setLivePos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      null,
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    return () => { if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current); };
  }, [started]);

  // Current hole GPS data
  const holeData = useMemo(() => {
    if (!course?.holes?.length) return null;
    return course.holes.find((h) => Number(h.hole_number || h.holeNumber || h.number || h.hole) === hole) || null;
  }, [course, hole]);

  const greenLoc = useMemo(() => extractGreen(holeData) || manualPin[hole] || null, [holeData, manualPin, hole]);

  // Raw distance to pin
  const rawPinDist = useMemo(() => {
    if (!livePos || !greenLoc) return null;
    return yardsBetween(livePos, greenLoc);
  }, [livePos, greenLoc]);

  // Animate pin distance
  useEffect(() => {
    if (rawPinDist === null) { setPinDist(null); return; }
    if (pinDist === null) { setPinDist(rawPinDist); setPinDistKey((k) => k + 1); return; }
    if (pinAnimRef.current) cancelAnimationFrame(pinAnimRef.current);
    const start = pinDist, end = rawPinDist, dur = 400, t0 = performance.now();
    setPinDistKey((k) => k + 1);
    const tick = (now) => {
      const progress = Math.min((now - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      setPinDist(Math.round(start + (end - start) * ease));
      if (progress < 1) pinAnimRef.current = requestAnimationFrame(tick);
    };
    pinAnimRef.current = requestAnimationFrame(tick);
    return () => { if (pinAnimRef.current) cancelAnimationFrame(pinAnimRef.current); };
  }, [rawPinDist]);

  // Adjusted distance (wind + elevation)
  const adjDist = useMemo(() => {
    if (rawPinDist == null) return null;
    let adj = rawPinDist;
    if (weather?.elevationFt) adj = Math.round(adj / (1 + (weather.elevationFt / 1000) * 0.02));
    if (weather?.windSpeed > 2 && livePos && greenLoc) {
      const bearing = bearingTo(livePos, greenLoc);
      adj += windAdj(weather.windSpeed, weather.windDir, bearing);
    }
    return adj;
  }, [rawPinDist, weather, livePos, greenLoc]);

  // Club averages
  const clubAvg = useMemo(() => {
    const m = {};
    CLUBS.forEach((name) => {
      const list = allShots.filter((s) => s.club === name && s.distance > 0);
      m[name] = list.length >= MIN_SHOTS ? Math.round(list.reduce((s, x) => s + x.distance, 0) / list.length) : DEFAULT_CLUB_DIST[name];
    });
    return m;
  }, [allShots]);

  const clubPersonal = useMemo(() => {
    const m = {};
    CLUBS.forEach((name) => { m[name] = allShots.filter((s) => s.club === name && s.distance > 0).length >= MIN_SHOTS; });
    return m;
  }, [allShots]);

  const suggestedClub = useMemo(() => {
    const target = adjDist != null ? adjDist : rawPinDist;
    if (target == null) return null;
    const eligible = CLUBS.filter((c) => c !== "Putter" || target < 30);
    let best = null, bestDiff = Infinity;
    eligible.forEach((name) => {
      const diff = Math.abs((clubAvg[name] || 999) - target);
      if (diff < bestDiff) { bestDiff = diff; best = name; }
    });
    return best;
  }, [adjDist, rawPinDist, clubAvg]);

  // Score totals
  const totals = useMemo(() => {
    let strokes = 0, played = 0, playedPar = 0, putts = 0, penalties = 0, firH = 0, firT = 0, girH = 0, girT = 0;
    HOLES.forEach((h) => {
      const r = scores[h] || BLANK_SCORE;
      const s = Number(r.strokes);
      if (s > 0) { strokes += s; played++; playedPar += Number(r.par) || 4; }
      putts += Number(r.putts) || 0;
      penalties += Number(r.penalties) || 0;
      if (r.par >= 4) { firT++; if (r.fir === true) firH++; }
      girT++; if (r.gir === true) girH++;
    });
    const firPct = firT ? Math.round(firH / firT * 100) : null;
    const girPct = girT ? Math.round(girH / girT * 100) : null;
    return { strokes, played, toPar: strokes ? strokes - playedPar : 0, putts, penalties, firH, firT, girH, girT, firPct, girPct };
  }, [scores]);

  // Session stats
  const longest = useMemo(() => shots.reduce((b, s) => s.distance > (b?.distance || 0) ? s : b, null), [shots]);
  const avgDist = useMemo(() => shots.length ? Math.round(shots.reduce((s, x) => s + (x.distance || 0), 0) / shots.length) : 0, [shots]);
  const goodRate = useMemo(() => shots.length ? Math.round(shots.filter((s) => s.result === "Good").length / shots.length * 100) : 0, [shots]);

  // Club stats this round
  const clubStats = useMemo(() => CLUBS.map((name) => {
    const list = shots.filter((s) => s.club === name && s.distance > 0);
    if (!list.length) return null;
    return { name, count: list.length, avg: Math.round(list.reduce((s, x) => s + x.distance, 0) / list.length), best: Math.max(...list.map((s) => s.distance)) };
  }).filter(Boolean), [shots]);

  // Club gapping
  const gapData = useMemo(() => {
    const clubs = CLUBS.map((name) => {
      const list = allShots.filter((s) => s.club === name && s.distance > 0);
      if (list.length < MIN_SHOTS) return null;
      return { name, avg: Math.round(list.reduce((s, x) => s + x.distance, 0) / list.length) };
    }).filter(Boolean).sort((a, b) => b.avg - a.avg);
    const gaps = [];
    for (let i = 0; i < clubs.length - 1; i++) {
      const g = clubs[i].avg - clubs[i + 1].avg;
      if (g > 20) gaps.push({ high: clubs[i], low: clubs[i + 1], gap: g });
    }
    return { clubs, gaps };
  }, [allShots]);

  // Miss tendency
  const misses = useMemo(() => CLUBS.map((name) => {
    const list = allShots.filter((s) => s.club === name);
    if (list.length < 5) return null;
    const counts = { Left: 0, Right: 0, Short: 0, Long: 0 };
    list.forEach((s) => { if (counts[s.result] !== undefined) counts[s.result]++; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [dir, cnt] = sorted[0];
    if (cnt / list.length < 0.25) return null;
    return { name, dir, pct: Math.round(cnt / list.length * 100), goodPct: Math.round(list.filter((s) => s.result === "Good").length / list.length * 100) };
  }).filter(Boolean), [allShots]);

  // Trends
  const trends = useMemo(() => {
    const rounds = [...history].reverse().slice(0, 10);
    return {
      toPar: rounds.filter((r) => r.strokes > 0).map((r) => r.toPar),
      longest: rounds.filter((r) => r.longestDrive > 0).map((r) => r.longestDrive),
      putts: rounds.filter((r) => r.totalPutts > 0).map((r) => r.totalPutts),
    };
  }, [history]);

  // Map
  const lastLoc = currentShot?.start || shots[0]?.end || shots[0]?.start;
  const mapCenter = lastLoc ? [lastLoc.lat, lastLoc.lng] : [40.2015, -77.189];
  const visShots = useMemo(() => mapMode === "hole" ? shots.filter((s) => s.hole === hole) : shots, [shots, hole, mapMode]);
  const shotLines = useMemo(() => visShots.filter((s) => s.start && s.end).map((s) => ({ id: s.id, pos: [[s.start.lat, s.start.lng], [s.end.lat, s.end.lng]] })), [visShots]);

  // Handlers
  function handleCourseSelect(c) {
    setCourse(c);
    if (c?.holes?.length) {
      setScores((prev) => {
        const u = { ...prev };
        c.holes.forEach((h) => {
          const n = Number(h.hole_number || h.holeNumber || h.number || h.hole);
          if (n >= 1 && n <= 18) u[n] = { ...u[n], par: extractPar(h) };
        });
        return u;
      });
    }
  }

  function startRound() { setStarted(true); setTab("track"); setStatus("Round started. Choose a club and tap Hit Shot."); }

  async function hitShot() {
    setLoading(true); setStatus("Locking your position...");
    try {
      const loc = await getLocation();
      setCurrentShot({ id: crypto.randomUUID(), club, shotShape: shape, lie, result, note, hole, start: loc, startedAt: loc.time });
      setStatus(`${club} marked. Walk to your ball, then tap Ball Found Here.`);
    } catch { setStatus("GPS failed. Check location permission and try again."); }
    finally { setLoading(false); }
  }

  async function ballFound() {
    if (!currentShot) { setStatus("Tap Hit Shot first."); return; }
    setLoading(true); setStatus("Locking ball location...");
    try {
      const end = await getLocation();
      const distance = yardsBetween(currentShot.start, end);
      const done = { ...currentShot, result, note, end, distance, finishedAt: end.time };
      setShots((prev) => [done, ...prev]);
      setCurrentShot(null); setNote("");
      setStatus(`${currentShot.club} · ${distance} yards.`);
    } catch { setStatus("GPS failed. Stand still and try again."); }
    finally { setLoading(false); }
  }

  function openMaps(pt) { if (!pt) return; window.open(`https://www.google.com/maps/search/?api=1&query=${pt.lat},${pt.lng}`, "_blank"); }
  function lostBall() { if (!currentShot) { setStatus("Tap Hit Shot first."); return; } openMaps(currentShot.start); }
  function updateScore(h, field, value) { setScores((prev) => ({ ...prev, [h]: { ...(prev[h] || BLANK_SCORE), [field]: value } })); }

  function endRound() {
    const done = shots.filter((s) => s.distance > 0);
    if (done.length > 0) setAllShots((prev) => [...prev, ...done]);
    if (totals.played > 0 || done.length > 0) {
      const best = done.reduce((b, s) => s.distance > (b?.distance || 0) ? s : b, null);
      setHistory((prev) => [{
        id: crypto.randomUUID(), date: new Date().toISOString(),
        courseName: course ? extractCourseName(course.raw) : "Unknown Course",
        holesPlayed: totals.played, strokes: totals.strokes, toPar: totals.toPar,
        shotsTracked: done.length, longestDrive: best?.distance || 0, longestClub: best?.club || "",
        totalPutts: totals.putts, firH: totals.firH, firT: totals.firT, girH: totals.girH, girT: totals.girT,
      }, ...prev]);
    }
    setShots([]); setCurrentShot(null); setHole(1);
    setScores(Object.fromEntries(HOLES.map((h) => [h, { ...BLANK_SCORE }])));
    setCourse(null); setStarted(false); setTab("track"); setStatus("Ready when you are.");
    setDetect({ state: "idle", course: null });
    ["tb_shots","tb_scores","tb_started","tb_hole","tb_course"].forEach((k) => localStorage.removeItem(k));
  }

  // ── Splash ────────────────────────────────────────────────────────────────────
  if (splash) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#f9fafb", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: splashOut ? 0 : 1, transition: "opacity 0.5s ease", zIndex: 100 }}>
        <img src="/tracerbuddy-icon.png" alt="TracerBuddy" style={{ width: 100, height: 100, borderRadius: 24, marginBottom: 28 }} />
        <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: "-0.5px", marginBottom: 8 }}>
          <span style={{ color: GREEN }}>Tracer</span><span style={{ color: AMBER }}>Buddy</span>
        </div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 48, textTransform: "uppercase", letterSpacing: "0.08em" }}>The smarter way to track every shot.</div>
        <div style={{ display: "flex", gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: AMBER, opacity: 0.3 + i * 0.35 }} />
          ))}
        </div>
      </div>
    );
  }

  // ── Pre-round ─────────────────────────────────────────────────────────────────
  if (!started) {
    return (
      <div style={{ minHeight: "100vh", background: "#f9fafb", padding: "0 16px 24px" }}>
        <div style={{ maxWidth: 420, margin: "0 auto", display: "flex", flexDirection: "column", minHeight: "100vh", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "28px 0 20px" }}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: "-0.5px" }}><span style={{ color: GREEN }}>Tracer</span><span style={{ color: AMBER }}>Buddy</span></div>
                <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 2 }}>The smarter way to track every shot.</div>
              </div>
              <div style={{ width: 44, height: 44, background: GREEN, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⛳</div>
            </div>

            {!online && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, padding: "10px 14px", fontSize: 12, fontWeight: 700, color: "#dc2626", marginBottom: 14 }}>⚡ Offline — using cached data</div>}

            <Card className="p-0" style={{ overflow: "hidden", marginBottom: 16 }}>
              <div style={{ background: "linear-gradient(135deg, rgba(21,128,61,0.08), rgba(180,83,9,0.06))", padding: 20 }}>
                <div style={{ height: 64, background: "white", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, marginBottom: 12, border: "1px solid #e5e7eb" }}>🎯</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: "#111827", marginBottom: 6 }}>Ready for the course?</div>
                <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>GPS shot tracing · Live distance to pin · Club suggestions</div>
              </div>
            </Card>

            <CourseSearch onSelect={(c) => { handleCourseSelect(c); setDetect((p) => ({ ...p, state: "dismissed" })); }} selected={course} />

            {detect.state === "detecting" && !course && (
              <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: "14px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 18 }}>📡</span>
                <div><div style={{ fontSize: 13, fontWeight: 900, color: "#111827" }}>Detecting your course...</div><div style={{ fontSize: 11, color: "#9ca3af" }}>Checking nearby golf courses</div></div>
              </div>
            )}

            {detect.state === "found" && !course && (
              <div style={{ background: AMBER_LIGHT, border: `1px solid ${AMBER_BORDER}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 900, color: AMBER, textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 4 }}>Detected Nearby · {detect.course.distMi} mi</div>
                <div style={{ fontSize: 16, fontWeight: 900, color: "#111827", marginBottom: 2 }}>{extractCourseName(detect.course)}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>{[detect.course?.location?.city, detect.course?.location?.state].filter(Boolean).join(", ")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <button onClick={async () => {
                    const id = detect.course.id || detect.course.course_id;
                    try {
                      if (id) { const d = await apiFetchCourse(id); handleCourseSelect({ raw: detect.course, holes: extractHoles(d) }); }
                      else { handleCourseSelect({ raw: detect.course, holes: [] }); }
                      setDetect((p) => ({ ...p, state: "dismissed" }));
                    } catch {}
                  }} style={{ background: GREEN, color: "white", border: "none", borderRadius: 10, padding: "10px 0", fontSize: 13, fontWeight: 900, cursor: "pointer" }}>Yes, that's it ✓</button>
                  <button onClick={() => setDetect((p) => ({ ...p, state: "dismissed" }))} style={{ background: "white", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 0", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Not my course</button>
                </div>
              </div>
            )}

            {(weather || weatherLoading) && (
              <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: 14, marginBottom: 14 }}>
                {weatherLoading ? <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center" }}>Fetching conditions...</div> : weather && (
                  <>
                    <div style={{ fontSize: 10, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 10 }}>Course Conditions</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                      {[["WIND", `${weather.windSpeed}mph`], ["DIR", windDirLabel(weather.windDir)], ["TEMP", `${weather.tempF}°F`], ["ELEV", `${weather.elevationFt}ft`]].map(([l, v]) => (
                        <div key={l} style={{ background: "#f9fafb", borderRadius: 10, padding: "8px 4px", textAlign: "center" }}>
                          <div style={{ fontSize: 9, color: "#9ca3af" }}>{l}</div>
                          <div style={{ fontSize: 13, fontWeight: 900, color: "#111827", marginTop: 2 }}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 8 }}>{weatherLabel(weather.weatherCode)} · Adjustments applied to suggestions</div>
                  </>
                )}
              </div>
            )}
          </div>

          <div style={{ paddingBottom: 16 }}>
            <button onClick={startRound} style={{ width: "100%", height: 58, background: GREEN, color: "white", border: "none", borderRadius: 16, fontSize: 16, fontWeight: 900, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>Start Round</button>
            <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", marginTop: 10 }}>Best used outdoors with location permission on.</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Round screen ───────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "#f9fafb" }}>
      <div style={{ maxWidth: 420, margin: "0 auto" }}>

        {!online && <div style={{ background: "#fef2f2", borderBottom: "1px solid #fecaca", padding: "8px 16px", fontSize: 11, fontWeight: 700, color: "#dc2626", textAlign: "center" }}>⚡ Offline — GPS still works</div>}

        {/* Header */}
        <div style={{ position: "sticky", top: 0, zIndex: 20, background: "white", borderBottom: "1px solid #e5e7eb", padding: "14px 16px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: "-0.4px" }}><span style={{ color: GREEN }}>Tracer</span><span style={{ color: AMBER }}>Buddy</span></div>
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{course ? extractCourseName(course.raw) : "No course loaded"}</div>
            </div>
            <div style={{ background: AMBER_LIGHT, border: `1px solid ${AMBER_BORDER}`, borderRadius: 10, padding: "6px 12px", fontSize: 12, fontWeight: 900, color: AMBER }}>Hole {hole}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 3, background: "#f3f4f6", borderRadius: 12, padding: 3 }}>
            <Tab active={tab === "track"} icon="📍" label="Track" onClick={() => setTab("track")} />
            <Tab active={tab === "map"} icon="🗺️" label="Map" onClick={() => setTab("map")} />
            <Tab active={tab === "score"} icon="⛳" label="Score" onClick={() => setTab("score")} />
            <Tab active={tab === "stats"} icon="📊" label="Stats" onClick={() => setTab("stats")} />
          </div>
        </div>

        <div style={{ padding: "14px 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* ── TRACK ── */}
          {tab === "track" && (
            <>
              {/* Distance card */}
              {greenLoc && (
                <div style={{ background: "white", border: "1px solid #e5e7eb", borderTop: `3px solid ${GREEN}`, borderRadius: 18, padding: 18 }}>
                  <div style={{ fontSize: 9, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8 }}>Distance to Pin · Hole {hole}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span key={pinDistKey} style={{ fontSize: 64, fontWeight: 900, color: GREEN, lineHeight: 1, letterSpacing: "-2px" }}>{pinDist != null ? pinDist : "—"}</span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#d1d5db" }}>yds</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                      {livePos && <div style={{ display: "flex", alignItems: "center", gap: 5, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "4px 10px" }}><div style={{ width: 5, height: 5, borderRadius: "50%", background: GREEN }} /><span style={{ fontSize: 10, fontWeight: 700, color: GREEN }}>Live GPS</span></div>}
                      {holeData && <span style={{ fontSize: 11, color: "#9ca3af" }}>Par {extractPar(holeData)}</span>}
                    </div>
                  </div>
                  {rawPinDist != null && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f3f4f6" }}>
                      {suggestedClub ? (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 900, color: GREEN }}>★ Suggested club</div>
                            {adjDist != null && adjDist !== rawPinDist && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>{rawPinDist}y → {adjDist}y adjusted{weather?.windSpeed > 2 ? ` · ${weather.windSpeed}mph ${windDirLabel(weather.windDir)}` : ""}</div>}
                            <div style={{ fontSize: 10, color: "#9ca3af" }}>{clubAvg[suggestedClub]}y · {clubPersonal[suggestedClub] ? "your avg" : "default"}</div>
                          </div>
                          <div style={{ background: AMBER_LIGHT, border: `1px solid ${AMBER_BORDER}`, borderRadius: 10, padding: "8px 14px", fontSize: 14, fontWeight: 900, color: AMBER }}>{suggestedClub}</div>
                        </div>
                      ) : <div style={{ fontSize: 11, color: "#9ca3af" }}>Play more rounds to get personalized suggestions</div>}
                    </div>
                  )}
                </div>
              )}

              {/* Hole + Club */}
              <Card>
                <div style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 14, padding: 8, marginBottom: 16 }}>
                    <button onClick={() => setHole(Math.max(1, hole - 1))} style={{ width: 44, height: 38, background: "white", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 20, fontWeight: 900, color: "#374151", cursor: "pointer" }}>−</button>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.15em" }}>Current Hole</div>
                      <div style={{ fontSize: 28, fontWeight: 900, color: "#111827", lineHeight: 1.1 }}>{hole}</div>
                    </div>
                    <button onClick={() => setHole(Math.min(18, hole + 1))} style={{ width: 44, height: 38, background: "white", border: "1px solid #e5e7eb", borderRadius: 10, fontSize: 20, fontWeight: 900, color: "#374151", cursor: "pointer" }}>+</button>
                  </div>

                  <div style={{ fontSize: 9, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8 }}>Club</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, marginBottom: 16 }}>
                    {CLUBS.map((item) => <Pill key={item} active={club === item} suggested={suggestedClub === item} color="green" onClick={() => setClub(item)}>{item}</Pill>)}
                  </div>

                  <div style={{ fontSize: 9, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8 }}>Shot Type</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 16 }}>
                    {SHOT_SHAPES.map((item) => <Pill key={item} active={shape === item} color="amber" onClick={() => setShape(item)}>{item}</Pill>)}
                  </div>

                  <div style={{ fontSize: 9, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8 }}>Lie</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
                    {LIES.map((item) => <Pill key={item} active={lie === item} color="dark" onClick={() => setLie(item)}>{item}</Pill>)}
                  </div>
                </div>
              </Card>

              {/* GPS buttons */}
              <Card>
                <div style={{ padding: 16 }}>
                  <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 14, padding: 16, textAlign: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 36, marginBottom: 6 }}>🎯</div>
                    <div style={{ fontSize: 14, fontWeight: 900, color: "#111827" }}>GPS Shot Tracker</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>Stand still when marking shots for best accuracy.</div>
                  </div>
                  <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#374151", marginBottom: 14 }}>{loading ? "Working..." : status}</div>
                  <div style={{ fontSize: 9, fontWeight: 900, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 8 }}>Result</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 12 }}>
                    {RESULTS.map((item) => <Pill key={item} active={result === item} color="green" onClick={() => setResult(item)}>{item}</Pill>)}
                  </div>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note: wind, contact, target..." style={{ width: "100%", background: "white", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 14px", fontSize: 13, color: "#111827", outline: "none", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
                    <button disabled={loading} onClick={hitShot} style={{ height: 56, background: GREEN, color: "white", border: "none", borderRadius: 14, fontSize: 15, fontWeight: 900, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>📍 Hit Shot</button>
                    <button disabled={loading} onClick={ballFound} style={{ height: 56, background: AMBER, color: "white", border: "none", borderRadius: 14, fontSize: 15, fontWeight: 900, cursor: "pointer", opacity: loading ? 0.5 : 1 }}>✅ Ball Found Here</button>
                    <button onClick={lostBall} style={{ height: 44, background: "#f9fafb", color: "#9ca3af", border: "1px solid #e5e7eb", borderRadius: 12, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>⚠ Lost Ball / Open Last Hit Spot</button>
                  </div>
                </div>
              </Card>
            </>
          )}

          {/* ── MAP ── */}
          {tab === "map" && (
            <Card>
              <div style={{ padding: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div><div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.16em" }}>Satellite Map</div><div style={{ fontSize: 22, fontWeight: 900, color: "#111827" }}>{mapMode === "hole" ? `Hole ${hole}` : "Full Round"}</div></div>
                  <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "6px 12px", fontSize: 11, fontWeight: 700, color: "#374151" }}>±{lastLoc?.accuracy || "—"}m</div>
                </div>

                {rawPinDist != null && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, padding: "10px 14px", marginBottom: 12 }}><span style={{ fontSize: 11, fontWeight: 900, color: GREEN }}>Distance to Pin</span><span style={{ fontSize: 22, fontWeight: 900, color: GREEN }}>{rawPinDist} yds</span></div>}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
                  {[["Shots", visShots.length], ["Lines", shotLines.length], ["Yards", visShots.reduce((s, x) => s + (x.distance || 0), 0) || "—"]].map(([l, v]) => (
                    <div key={l} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 12, padding: "8px 10px" }}><div style={{ fontSize: 9, color: "#9ca3af" }}>{l}</div><div style={{ fontSize: 16, fontWeight: 900, color: "#111827" }}>{v}</div></div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, background: "#f3f4f6", borderRadius: 10, padding: 3 }}>
                    <button onClick={() => setMapMode("hole")} style={{ borderRadius: 8, padding: "6px 0", fontSize: 10, fontWeight: 900, background: mapMode === "hole" ? GREEN : "transparent", color: mapMode === "hole" ? "white" : "#9ca3af", border: "none", cursor: "pointer" }}>Current</button>
                    <button onClick={() => setMapMode("round")} style={{ borderRadius: 8, padding: "6px 0", fontSize: 10, fontWeight: 900, background: mapMode === "round" ? GREEN : "transparent", color: mapMode === "round" ? "white" : "#9ca3af", border: "none", cursor: "pointer" }}>Round</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, background: "#f3f4f6", borderRadius: 10, padding: 3 }}>
                    <button onClick={() => setAutoFit(true)} style={{ borderRadius: 8, padding: "6px 0", fontSize: 10, fontWeight: 900, background: autoFit ? GREEN : "transparent", color: autoFit ? "white" : "#9ca3af", border: "none", cursor: "pointer" }}>Auto Fit</button>
                    <button onClick={() => setAutoFit(false)} style={{ borderRadius: 8, padding: "6px 0", fontSize: 10, fontWeight: 900, background: !autoFit ? GREEN : "transparent", color: !autoFit ? "white" : "#9ca3af", border: "none", cursor: "pointer" }}>Free</button>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <button
                    onClick={() => setPinSetMode((p) => !p)}
                    style={{ flex: 1, height: 44, background: pinSetMode ? GREEN : "#fef3c7", border: `1px solid ${pinSetMode ? GREEN : "#fcd34d"}`, borderRadius: 12, fontSize: 13, fontWeight: 900, color: pinSetMode ? "white" : "#b45309", cursor: "pointer" }}
                  >
                    {pinSetMode ? "⛳ Tap map to set pin..." : `📍 Set Pin for Hole ${hole}`}
                  </button>
                  {manualPin[hole] && (
                    <button
                      onClick={() => setManualPin((p) => { const n = { ...p }; delete n[hole]; return n; })}
                      style={{ width: 44, height: 44, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, fontSize: 13, color: "#dc2626", cursor: "pointer", fontWeight: 900 }}
                    >✕</button>
                  )}
                </div>
                  <div style={{ height: 420 }}>
                    <MapContainer center={mapCenter} zoom={17} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
                      <TileLayer attribution="Esri" url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
                      <RecenterMap center={mapCenter} zoom={17} enabled={!autoFit} />
                      <FitBounds shots={visShots} currentShot={currentShot} enabled={autoFit} />
                      <MapClickHandler onMapClick={(loc) => { if (pinSetMode) { setManualPin((p) => ({ ...p, [hole]: loc })); setPinSetMode(false); } }} enabled={pinSetMode} />
                      {extractGreen(holeData) && mapMode === "hole" && <Marker icon={makeGreenIcon()} position={[extractGreen(holeData).lat, extractGreen(holeData).lng]}><Popup>Hole {hole} Pin{rawPinDist ? ` · ${rawPinDist} yds` : ""}</Popup></Marker>}
                      {manualPin[hole] && !extractGreen(holeData) && <Marker icon={makePinSetIcon()} position={[manualPin[hole].lat, manualPin[hole].lng]}><Popup>Hole {hole} Pin (manual){rawPinDist ? ` · ${rawPinDist} yds` : ""}</Popup></Marker>}
                      {currentShot?.start && <Marker icon={makeStartIcon()} position={[currentShot.start.lat, currentShot.start.lng]}><Popup>{currentShot.club} · Hole {currentShot.hole}</Popup></Marker>}
                      {visShots.map((s, i) => (
                        <React.Fragment key={s.id}>
                          {s.start && <Marker icon={makeStartIcon()} position={[s.start.lat, s.start.lng]}><Popup>Shot {i + 1} · {s.club} · {fmtTime(s.startedAt)}</Popup></Marker>}
                          {s.end && <Marker icon={makeEndIcon(i + 1)} position={[s.end.lat, s.end.lng]}><Popup>{s.club} · {s.distance}y · Hole {s.hole}</Popup></Marker>}
                        </React.Fragment>
                      ))}
                      {shotLines.map((line) => <Polyline key={line.id} positions={line.pos} pathOptions={{ color: AMBER, weight: 4, opacity: 0.9, dashArray: "8 6" }} />)}
                    </MapContainer>
                  </div>
                </div>

                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <button onClick={() => openMaps(lastLoc)} style={{ height: 52, background: GREEN, color: "white", border: "none", borderRadius: 12, fontSize: 13, fontWeight: 900, cursor: "pointer" }}>Open Maps</button>
                  <button onClick={lostBall} style={{ height: 52, background: "#f9fafb", color: "#374151", border: "1px solid #e5e7eb", borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Find Ball</button>
                </div>
              </div>
            </Card>
          )}

          {/* ── SCORE ── */}
          {tab === "score" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Stat label="Score" value={totals.strokes || "—"} sub={totals.strokes ? (totals.toPar > 0 ? `+${totals.toPar}` : totals.toPar === 0 ? "Even" : `${totals.toPar}`) : "—"} />
                <Stat label="Putts" value={totals.putts || "—"} sub={totals.played ? `${Math.round(totals.putts / totals.played * 10) / 10} per hole` : ""} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                <Stat label="FIR %" value={totals.firPct != null ? `${totals.firPct}%` : "—"} sub={totals.firT ? `${totals.firH}/${totals.firT}` : ""} />
                <Stat label="GIR %" value={totals.girPct != null ? `${totals.girPct}%` : "—"} sub={totals.girT ? `${totals.girH}/${totals.girT}` : ""} />
                <Stat label="Penalties" value={totals.penalties || "0"} />
              </div>

              <Card>
                <div style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <div><div style={{ fontSize: 16, fontWeight: 900, color: "#111827" }}>Scorecard</div><div style={{ fontSize: 11, color: "#9ca3af" }}>{course ? "Pars loaded from course." : "Enter strokes after each hole."}</div></div>
                    <button onClick={() => setScores(Object.fromEntries(HOLES.map((h) => [h, { ...BLANK_SCORE }])))} style={{ background: "#f3f4f6", border: "none", borderRadius: 10, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: "#374151", cursor: "pointer" }}>Reset</button>
                  </div>

                  {/* Column headers */}
                  <div style={{ display: "grid", gridTemplateColumns: "38px 1fr 72px 52px 30px", gap: 5, marginBottom: 6, padding: "0 2px" }}>
                    {["#", "Strokes", "Putts", "F  G", "⚠"].map((h) => <div key={h} style={{ fontSize: 9, color: "#d1d5db", fontWeight: 700, textAlign: "center" }}>{h}</div>)}
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {HOLES.map((h) => {
                      const r = scores[h] || BLANK_SCORE;
                      const s = Number(r.strokes) || 0;
                      const sg = s > 0 ? s - r.par : null;
                      const sgColor = sg != null ? (sg < 0 ? GREEN : sg > 0 ? "#dc2626" : "#6b7280") : "transparent";
                      const isCur = hole === h;
                      return (
                        <div key={h}>
                          <div style={{ display: "grid", gridTemplateColumns: "38px 1fr 72px 52px 30px", gap: 5, alignItems: "center", background: isCur ? "#f0fdf4" : "#f9fafb", border: isCur ? `1px solid #bbf7d0` : "1px solid transparent", borderRadius: 14, padding: "5px 5px" }}>
                            {/* Hole btn */}
                            <button onClick={() => setHole(h)} style={{ height: 32, borderRadius: 9, fontWeight: 900, fontSize: 13, background: isCur ? GREEN : "white", color: isCur ? "white" : "#374151", border: "1px solid #e5e7eb", cursor: "pointer", position: "relative" }}>
                              {h}
                              {sg != null && <span style={{ position: "absolute", top: -5, right: -5, background: sgColor, color: "white", fontSize: 8, fontWeight: 900, borderRadius: 999, padding: "1px 4px", minWidth: 14, textAlign: "center" }}>{sg > 0 ? `+${sg}` : sg === 0 ? "E" : sg}</span>}
                            </button>
                            {/* Strokes */}
                            <div style={{ display: "flex", alignItems: "center", gap: 2, background: "white", border: "1px solid #e5e7eb", borderRadius: 10, padding: "2px 4px" }}>
                              <button onClick={() => updateScore(h, "strokes", Math.max(0, s - 1))} style={{ width: 26, height: 26, borderRadius: 7, background: "#f3f4f6", border: "none", fontWeight: 900, fontSize: 14, color: "#374151", cursor: "pointer", flexShrink: 0 }}>−</button>
                              <div style={{ flex: 1, textAlign: "center", fontWeight: 900, fontSize: 15, color: s > 0 ? "#111827" : "#d1d5db" }}>{s > 0 ? s : "·"}</div>
                              <button onClick={() => updateScore(h, "strokes", s + 1)} style={{ width: 26, height: 26, borderRadius: 7, background: "#f3f4f6", border: "none", fontWeight: 900, fontSize: 14, color: "#374151", cursor: "pointer", flexShrink: 0 }}>+</button>
                            </div>
                            {/* Putts */}
                            {(() => { const p = Number(r.putts) || 0; return (
                              <div style={{ display: "flex", alignItems: "center", gap: 2, background: "white", border: "1px solid #e5e7eb", borderRadius: 10, padding: "2px 3px" }}>
                                <button onClick={() => updateScore(h, "putts", Math.max(0, p - 1))} style={{ width: 20, height: 26, borderRadius: 6, background: "#f3f4f6", border: "none", fontWeight: 900, fontSize: 12, color: "#374151", cursor: "pointer", flexShrink: 0 }}>−</button>
                                <div style={{ flex: 1, textAlign: "center", fontWeight: 900, fontSize: 13, color: p > 0 ? "#7c3aed" : "#d1d5db" }}>{p > 0 ? p : "·"}</div>
                                <button onClick={() => updateScore(h, "putts", p + 1)} style={{ width: 20, height: 26, borderRadius: 6, background: "#f3f4f6", border: "none", fontWeight: 900, fontSize: 12, color: "#374151", cursor: "pointer", flexShrink: 0 }}>+</button>
                              </div>
                            ); })()}
                            {/* FIR + GIR */}
                            <div style={{ display: "flex", gap: 3 }}>
                              {r.par >= 4 ? <button onClick={() => updateScore(h, "fir", cycleGir(r.fir))} style={{ flex: 1, height: 32, borderRadius: 8, fontWeight: 900, fontSize: 10, background: r.fir === true ? GREEN : r.fir === false ? "#fef2f2" : "#f3f4f6", color: r.fir === true ? "white" : r.fir === false ? "#dc2626" : "#9ca3af", border: r.fir === false ? "1px solid #fecaca" : "none", cursor: "pointer" }}>{r.fir === true ? "F✓" : r.fir === false ? "F✗" : "F"}</button>
                              : <div style={{ flex: 1, height: 32, borderRadius: 8, background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#d1d5db" }}>—</div>}
                              <button onClick={() => updateScore(h, "gir", cycleGir(r.gir))} style={{ flex: 1, height: 32, borderRadius: 8, fontWeight: 900, fontSize: 10, background: r.gir === true ? GREEN : r.gir === false ? "#fef2f2" : "#f3f4f6", color: r.gir === true ? "white" : r.gir === false ? "#dc2626" : "#9ca3af", border: r.gir === false ? "1px solid #fecaca" : "none", cursor: "pointer" }}>{r.gir === true ? "G✓" : r.gir === false ? "G✗" : "G"}</button>
                            </div>
                            {/* Penalty */}
                            <button onClick={() => updateScore(h, "penalties", ((r.penalties || 0) + 1) % 5)} style={{ height: 32, borderRadius: 8, fontWeight: 900, fontSize: 11, background: r.penalties > 0 ? "#fef2f2" : "#f3f4f6", color: r.penalties > 0 ? "#dc2626" : "#9ca3af", border: r.penalties > 0 ? "1px solid #fecaca" : "none", cursor: "pointer" }}>{r.penalties > 0 ? `+${r.penalties}` : "·"}</button>
                          </div>
                          {isCur && (
                            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 6, padding: "5px 5px 0" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "4px 10px" }}>
                                <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 700 }}>Par</span>
                                {[3, 4, 5].map((p) => <button key={p} onClick={() => updateScore(h, "par", p)} style={{ width: 26, height: 26, borderRadius: 7, fontWeight: 900, fontSize: 12, background: r.par === p ? GREEN : "white", color: r.par === p ? "white" : "#374151", border: "1px solid #e5e7eb", cursor: "pointer" }}>{p}</button>)}
                              </div>
                              <input value={r.note || ""} onChange={(e) => updateScore(h, "note", e.target.value)} placeholder={`Hole ${h} note...`} style={{ height: 36, borderRadius: 10, background: "white", border: "1px solid #e5e7eb", padding: "0 12px", fontSize: 11, color: "#111827", outline: "none" }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Card>
            </>
          )}

          {/* ── STATS ── */}
          {tab === "stats" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                <Stat label="Shots" value={shots.length} />
                <Stat label="Long" value={longest ? `${longest.distance}y` : "—"} />
                <Stat label="Avg" value={avgDist ? `${avgDist}y` : "—"} />
                <Stat label="Good" value={goodRate ? `${goodRate}%` : "—"} />
              </div>

              {misses.length > 0 && (
                <Card>
                  <div style={{ padding: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#111827", marginBottom: 4 }}>🎯 Miss Tendency</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12 }}>Based on all tracked shots.</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {misses.map((m) => (
                        <div key={m.name} style={{ background: "#f9fafb", borderRadius: 12, padding: "10px 12px" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 13, fontWeight: 900, color: "#111827" }}>{m.name}</span>
                            <span style={{ fontSize: 10, fontWeight: 900, background: m.goodPct >= 70 ? "#f0fdf4" : "#fef3c7", color: m.goodPct >= 70 ? GREEN : AMBER, borderRadius: 999, padding: "2px 8px" }}>{m.goodPct}% good</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#6b7280" }}>Misses <strong style={{ color: AMBER }}>{m.dir}</strong> {m.pct}% of the time</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              )}

              {clubStats.length > 0 && (
                <Card>
                  <div style={{ padding: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#111827", marginBottom: 12 }}>Club Averages (This Round)</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {clubStats.map((r) => (
                        <div key={r.name} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", background: "#f9fafb", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
                          <span style={{ fontWeight: 700, color: "#111827" }}>{r.name}</span>
                          <span style={{ color: "#6b7280" }}>Avg {r.avg}y</span>
                          <span style={{ textAlign: "right", color: AMBER, fontWeight: 700 }}>Best {r.best}y</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              )}

              {gapData.clubs.length >= 2 && (
                <Card>
                  <div style={{ padding: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#111827", marginBottom: 4 }}>📐 Club Gapping</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12 }}>Min {MIN_SHOTS} shots per club.</div>
                    {gapData.gaps.length === 0 ? <div style={{ background: "#f0fdf4", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: GREEN }}>Bag looks well-gapped.</div> : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                        {gapData.gaps.map((g, i) => (
                          <div key={i} style={{ background: AMBER_LIGHT, border: `1px solid ${AMBER_BORDER}`, borderRadius: 12, padding: "10px 12px" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                              <span style={{ fontSize: 13, fontWeight: 900, color: AMBER }}>{g.gap}y gap</span>
                              {g.gap > 30 && <span style={{ fontSize: 10, fontWeight: 900, background: "#fef2f2", color: "#dc2626", borderRadius: 999, padding: "2px 8px" }}>Significant</span>}
                            </div>
                            <div style={{ fontSize: 11, color: "#374151" }}>{g.high.name} ({g.high.avg}y) → {g.low.name} ({g.low.avg}y)</div>
                            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>Consider ~{Math.round((g.high.avg + g.low.avg) / 2)}y club</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {gapData.clubs.map((c) => (
                        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 72, fontSize: 11, color: "#6b7280", flexShrink: 0 }}>{c.name}</span>
                          <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 999, overflow: "hidden" }}><div style={{ height: "100%", background: GREEN, borderRadius: 999, width: `${Math.min(100, (c.avg / 280) * 100)}%` }} /></div>
                          <span style={{ width: 40, fontSize: 11, fontWeight: 900, color: "#374151", textAlign: "right" }}>{c.avg}y</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              )}

              <Card>
                <div style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#111827" }}>↺ Shot History</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {allShots.length > 0 && <button onClick={() => exportCSV(allShots)} style={{ background: "#f0fdf4", border: "none", borderRadius: 10, padding: "7px 12px", fontSize: 12, fontWeight: 700, color: GREEN, cursor: "pointer" }}>↓ CSV</button>}
                      <button onClick={endRound} style={{ background: "#fef2f2", border: "none", borderRadius: 10, padding: "7px 12px", fontSize: 12, fontWeight: 700, color: "#dc2626", cursor: "pointer" }}>🗑 End Round</button>
                    </div>
                  </div>
                  {shots.length === 0 ? <div style={{ background: "#f9fafb", borderRadius: 12, padding: 16, fontSize: 13, color: "#9ca3af" }}>No shots yet. Go to Track and save your first shot.</div> : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {shots.map((s) => (
                        <div key={s.id} style={{ background: "#f9fafb", borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 900, color: "#111827" }}>{s.club} — {s.distance} yards</div>
                            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>Hole {s.hole} · {s.shotShape} · {s.lie} · {s.result} · {fmtTime(s.finishedAt)}</div>
                            {s.note && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>Note: {s.note}</div>}
                          </div>
                          <button onClick={() => openMaps(s.end)} style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 10, padding: "6px 10px", fontSize: 13, color: AMBER, cursor: "pointer", flexShrink: 0 }}>➤</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              {history.length > 0 && (
                <Card>
                  <div style={{ padding: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                      <div style={{ fontSize: 15, fontWeight: 900, color: "#111827" }}>📅 Round History</div>
                      <button onClick={() => { setHistory([]); localStorage.removeItem("tb_history"); }} style={{ background: "#f3f4f6", border: "none", borderRadius: 10, padding: "7px 12px", fontSize: 12, fontWeight: 700, color: "#9ca3af", cursor: "pointer" }}>Clear</button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {history.map((r) => {
                        const toParStr = r.strokes ? (r.toPar === 0 ? "E" : r.toPar > 0 ? `+${r.toPar}` : `${r.toPar}`) : "—";
                        const toParCol = r.toPar < 0 ? GREEN : r.toPar > 0 ? "#dc2626" : "#111827";
                        return (
                          <div key={r.id} style={{ background: "#f9fafb", borderRadius: 14, padding: "12px 14px" }}>
                            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                              <div><div style={{ fontSize: 13, fontWeight: 900, color: "#111827" }}>{r.courseName}</div><div style={{ fontSize: 11, color: "#9ca3af" }}>{fmtDate(r.date)}</div></div>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <div style={{ fontSize: 24, fontWeight: 900, color: toParCol }}>{toParStr}</div>
                                <button onClick={() => setShareRound(r)} style={{ background: AMBER_LIGHT, border: `1px solid ${AMBER_BORDER}`, borderRadius: 9, padding: "5px 10px", fontSize: 11, fontWeight: 700, color: AMBER, cursor: "pointer" }}>Share</button>
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6 }}>
                              {[["HOLES", r.holesPlayed], ["SCORE", r.strokes || "—"], ["PUTTS", r.totalPutts || "—"], ["LONG", r.longestDrive ? `${r.longestDrive}y` : "—"]].map(([l, v]) => (
                                <div key={l} style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 9, padding: "7px 4px", textAlign: "center" }}>
                                  <div style={{ fontSize: 8, color: "#9ca3af" }}>{l}</div>
                                  <div style={{ fontSize: 13, fontWeight: 900, color: "#111827", marginTop: 2 }}>{v}</div>
                                </div>
                              ))}
                            </div>
                            {(r.firT > 0 || r.girT > 0) && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 6 }}>FIR {r.firT ? `${r.firH}/${r.firT}` : "—"} · GIR {r.girT ? `${r.girH}/${r.girT}` : "—"}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Card>
              )}

              {history.length >= 2 && (
                <Card>
                  <div style={{ padding: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "#111827", marginBottom: 4 }}>📈 Trends</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 16 }}>Last {Math.min(10, history.length)} rounds.</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                      {trends.toPar.length >= 2 && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280" }}>Score vs Par</span><span style={{ fontSize: 11, color: "#9ca3af" }}>{trends.toPar[trends.toPar.length - 1] >= 0 ? "+" : ""}{trends.toPar[trends.toPar.length - 1]} last</span></div><Sparkline data={trends.toPar} color={AMBER} invert /></div>}
                      {trends.longest.length >= 2 && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280" }}>Longest Drive</span><span style={{ fontSize: 11, color: "#9ca3af" }}>{trends.longest[trends.longest.length - 1]}y last</span></div><Sparkline data={trends.longest} color={GREEN} /></div>}
                      {trends.putts.length >= 2 && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280" }}>Putts per Round</span><span style={{ fontSize: 11, color: "#9ca3af" }}>{trends.putts[trends.putts.length - 1]} last</span></div><Sparkline data={trends.putts} color="#7c3aed" invert /></div>}
                    </div>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* Share modal */}
      {shareRound && (() => {
        const r = shareRound;
        const toParStr = r.strokes ? (r.toPar === 0 ? "E" : r.toPar > 0 ? `+${r.toPar}` : `${r.toPar}`) : "—";
        const toParCol = r.toPar < 0 ? GREEN : r.toPar > 0 ? "#dc2626" : "#111827";
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div style={{ width: "100%", maxWidth: 360 }}>
              <div style={{ background: "white", borderRadius: 24, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
                <div style={{ background: "linear-gradient(135deg, rgba(21,128,61,0.08), rgba(180,83,9,0.06))", padding: "22px 22px 18px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <div><div style={{ fontSize: 20, fontWeight: 900 }}><span style={{ color: GREEN }}>Tracer</span><span style={{ color: AMBER }}>Buddy</span></div><div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>Round Summary</div></div>
                    <div style={{ fontSize: 30 }}>⛳</div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 900, color: "#111827" }}>{r.courseName}</div>
                  <div style={{ fontSize: 12, color: "#9ca3af" }}>{new Date(r.date).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
                </div>
                <div style={{ padding: "18px 22px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div><div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 4 }}>Score</div><div style={{ fontSize: 52, fontWeight: 900, color: "#111827", lineHeight: 1 }}>{r.strokes || "—"}</div></div>
                  <div style={{ textAlign: "right" }}><div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 4 }}>To Par</div><div style={{ fontSize: 52, fontWeight: 900, color: toParCol, lineHeight: 1 }}>{toParStr}</div></div>
                </div>
                <div style={{ padding: "16px 22px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[["Holes Played", r.holesPlayed], ["Shots Tracked", r.shotsTracked], ["Longest Drive", r.longestDrive ? `${r.longestDrive}y` : "—"], ["Total Putts", r.totalPutts || "—"], ["FIR / GIR", r.firT ? `${r.firH}/${r.firT} · ${r.girH}/${r.girT}` : "—"], ["Best Club", r.longestClub || "—"]].map(([l, v]) => (
                    <div key={l} style={{ background: "#f9fafb", borderRadius: 12, padding: "10px 12px" }}>
                      <div style={{ fontSize: 9, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>{l}</div>
                      <div style={{ fontSize: 15, fontWeight: 900, color: "#111827" }}>{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ padding: "0 22px 18px", textAlign: "center", fontSize: 11, color: "#d1d5db" }}>Tracked with TracerBuddy</div>
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", textAlign: "center", margin: "14px 0 10px" }}>Screenshot the card above to share</div>
              <button onClick={() => setShareRound(null)} style={{ width: "100%", height: 52, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 16, color: "white", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Close</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
