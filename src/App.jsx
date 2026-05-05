import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ─── API ─────────────────────────────────────────────────────────────────────
const GOLF_API_KEY = "YAHGWRREYXYA2FRGMXT2L7WSIA";
const GOLF_API_BASE = "https://api.golfcourseapi.com/v1";

async function apiSearchCourses(query) {
  const res = await fetch(`${GOLF_API_BASE}/search?search_query=${encodeURIComponent(query)}`, { headers: { Authorization: `Key ${GOLF_API_KEY}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function apiFetchCourse(id) {
  const k = `tracerbuddy_course_${id}`;
  const c = localStorage.getItem(k);
  if (c) return JSON.parse(c);
  const res = await fetch(`${GOLF_API_BASE}/courses/${id}`, { headers: { Authorization: `Key ${GOLF_API_KEY}` } });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  localStorage.setItem(k, JSON.stringify(data));
  return data;
}
function extractGreen(hole) {
  if (!hole) return null;
  const g = hole.green_location || hole.greenLocation || hole.pin_location || hole.green || null;
  if (!g) return null;
  const lat = g.lat ?? g.latitude ?? g.Lat ?? null;
  const lng = g.lng ?? g.lon ?? g.longitude ?? g.Lng ?? null;
  if (lat == null || lng == null) return null;
  return { lat, lng };
}
function extractPar(h) { return h?.par ?? h?.hole_par ?? h?.Par ?? 4; }
function extractHoles(d) { if (!d) return []; const r = d.course ?? d; return r.holes ?? r.Holes ?? []; }
function extractCourseName(r) { if (!r) return "Unknown Course"; return r.course_name || r.club_name || r.name || r.courseName || "Unknown Course"; }

// ─── Auto-detect course from GPS ─────────────────────────────────────────────
async function autoDetectNearby(lat, lng) {
  // Step 1: Reverse geocode to city name via Nominatim (free, no key)
  const geoRes = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=12`,
    { headers: { "Accept-Language": "en", "User-Agent": "TracerBuddy/1.0" } }
  );
  const geo = await geoRes.json();
  const addr = geo.address ?? {};
  const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || "";
  const state = addr.state || "";
  const query = [city, state].filter(Boolean).join(" ").trim();
  if (!query) throw new Error("Location unclear");

  // Step 2: Search GolfCourseAPI with city name
  const searchRes = await fetch(
    `${GOLF_API_BASE}/search?search_query=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Key ${GOLF_API_KEY}` } }
  );
  if (!searchRes.ok) throw new Error("Search failed");
  const searchData = await searchRes.json();
  const courses = searchData.courses ?? searchData.results ?? [];
  if (!courses.length) throw new Error("No courses found");

  // Step 3: Find closest course by comparing coordinates
  const withDist = courses.map(c => {
    const cLat = parseFloat(c.location?.latitude ?? c.latitude ?? c.lat ?? 0);
    const cLng = parseFloat(c.location?.longitude ?? c.longitude ?? c.lng ?? 0);
    if (!cLat || !cLng) return { ...c, distMiles: 999 };
    const distYards = yardsBetween({ lat, lng }, { lat: cLat, lng: cLng });
    return { ...c, distMiles: Math.round((distYards / 1760) * 10) / 10 };
  }).sort((a, b) => a.distMiles - b.distMiles);

  const nearest = withDist[0];
  if (nearest.distMiles > 3) throw new Error("No course within 3 miles");
  return nearest;
}

// ─── Weather & Elevation ──────────────────────────────────────────────────────
async function fetchWeatherAndElevation(lat, lng) {
  const [wr, er] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=weather_code,wind_speed_10m,wind_direction_10m,temperature_2m&wind_speed_unit=mph&temperature_unit=fahrenheit&forecast_days=1`),
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`),
  ]);
  const w = await wr.json(); const e = await er.json(); const c = w.current ?? {};
  return { windSpeed: Math.round(c.wind_speed_10m ?? 0), windDir: Math.round(c.wind_direction_10m ?? 0), tempF: Math.round(c.temperature_2m ?? 70), weatherCode: c.weather_code ?? 0, elevationFt: Math.round((e.elevation?.[0] ?? 0) * 3.28084) };
}
function weatherLabel(code) {
  if (code === 0) return "Clear"; if (code <= 3) return "Partly Cloudy"; if (code <= 48) return "Foggy";
  if (code <= 55) return "Drizzle"; if (code <= 65) return "Rain"; if (code <= 77) return "Snow"; if (code <= 82) return "Showers"; return "Stormy";
}
function windDirLabel(deg) { return ["N","NE","E","SE","S","SW","W","NW"][Math.round(deg/45)%8]; }
function bearingTo(a, b) {
  const dL = (b.lng-a.lng)*Math.PI/180, la1=a.lat*Math.PI/180, la2=b.lat*Math.PI/180;
  const y=Math.sin(dL)*Math.cos(la2), x=Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dL);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
function windAdj(speed, dir, bearing) {
  const toward=(dir+180)%360, angle=(bearing-toward)*Math.PI/180, comp=speed*Math.cos(angle);
  return Math.round(comp>0?comp*1.0:comp*0.7);
}

// ─── Leaflet fix ──────────────────────────────────────────────────────────────
if (typeof window !== "undefined") {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({ iconRetinaUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png", iconUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png", shadowUrl:"https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png" });
}

// ─── Constants ───────────────────────────────────────────────────────────────
const CLUBS=["Driver","3 Wood","Hybrid","4 Iron","5 Iron","6 Iron","7 Iron","8 Iron","9 Iron","PW","SW","Putter"];
const SHOT_SHAPES=["Straight","Fade","Draw","Slice","Hook","Punch","Chip","Putt"];
const LIES=["Tee","Fairway","Rough","Sand","Recovery","Green"];
const RESULTS=["Good","Left","Right","Short","Long","Lost","Penalty"];
const HOLES=Array.from({length:18},(_,i)=>i+1);
const DEFAULT_CLUB_DIST={"Driver":230,"3 Wood":210,"Hybrid":190,"4 Iron":175,"5 Iron":165,"6 Iron":155,"7 Iron":145,"8 Iron":135,"9 Iron":125,"PW":110,"SW":85,"Putter":15};
const MIN_SHOTS=3;
const BLANK_SCORE={par:4,strokes:"",putts:"",penalties:0,fir:null,gir:null,note:""};

// ─── Map icons ────────────────────────────────────────────────────────────────
function makeNumIcon(n,type="end"){const bg=type==="start"?"#15803d":"#b45309";return L.divIcon({className:"tb-pin",html:`<div style="width:28px;height:28px;border-radius:999px;background:${bg};color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;border:2px solid white;box-shadow:0 8px 18px rgba(0,0,0,.35);">${type==="start"?"S":n}</div>`,iconSize:[28,28],iconAnchor:[14,14],popupAnchor:[0,-14]});}
function makeCurrentIcon(){return L.divIcon({className:"tb-cur",html:`<div style="width:34px;height:34px;border-radius:999px;background:#fff;color:#ffffff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:15px;border:3px solid #b45309;box-shadow:0 10px 24px rgba(0,0,0,.4);">📍</div>`,iconSize:[34,34],iconAnchor:[17,17],popupAnchor:[0,-17]});}
function makeGreenIcon(){return L.divIcon({className:"tb-green",html:`<div style="width:30px;height:30px;border-radius:999px;background:#16a34a;color:#111827;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;border:2px solid white;box-shadow:0 8px 18px rgba(0,0,0,.35);">⛳</div>`,iconSize:[30,30],iconAnchor:[15,15],popupAnchor:[0,-15]});}

// ─── Utils ────────────────────────────────────────────────────────────────────
function yardsBetween(a,b){if(!a||!b)return 0;const R=6371e3,la1=(a.lat*Math.PI)/180,la2=(b.lat*Math.PI)/180,dLa=((b.lat-a.lat)*Math.PI)/180,dLn=((b.lng-a.lng)*Math.PI)/180,x=Math.sin(dLa/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLn/2)**2;return Math.round(R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))*1.09361);}
function getLocation(){return new Promise((res,rej)=>{if(!navigator.geolocation){rej(new Error("GPS not supported"));return;}navigator.geolocation.getCurrentPosition(p=>res({lat:p.coords.latitude,lng:p.coords.longitude,accuracy:Math.round(p.coords.accuracy),time:new Date().toISOString()}),rej,{enableHighAccuracy:true,timeout:12000,maximumAge:0});});}
function fmtTime(v){try{return new Date(v).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}catch{return "";}}
function fmtDate(v){return new Date(v).toLocaleDateString([],{month:"short",day:"numeric",year:"numeric"});}
function cycleState(cur){if(cur===null)return true;if(cur===true)return false;return null;}

// ─── Export CSV ───────────────────────────────────────────────────────────────
function exportShotsCSV(shots) {
  const hdr = ["Date","Hole","Club","Distance (yds)","Shot Shape","Lie","Result","Note","GPS Accuracy (m)"];
  const rows = shots.map(s => [
    fmtDate(s.finishedAt||s.startedAt), s.hole, s.club, s.distance,
    s.shotShape, s.lie, s.result, (s.note||"").replace(/"/g,"'"), s.end?.accuracy||""
  ]);
  const csv = [hdr,...rows].map(r=>r.map(v=>`"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv],{type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download=`tracerbuddy-shots-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── UI Components ────────────────────────────────────────────────────────────
function Card({children,className=""}){return <div className={"rounded-2xl border border-gray-200 bg-white text-white shadow-lg "+className}>{children}</div>;}
function PillBtn({active,children,onClick,tone="gold",suggested=false}){
  const ac=tone==="green"?"bg-emerald-300 text-[#ffffff]":tone==="white"?"bg-white text-[#ffffff]":"bg-amber-400 text-[#ffffff]";
  const sc="bg-emerald-900/60 text-[#15803d]/80 border border-emerald-400/50";
  let cls;
  if(active) cls=ac+(suggested?" ring-2 ring-green-600 ring-offset-1 ring-offset-[#f9fafb]":"");
  else if(suggested) cls=sc;
  else cls="bg-gray-100 text-gray-700";
  return <button onClick={onClick} className={"relative rounded-2xl px-3 py-2.5 text-[11px] font-black transition active:scale-95 "+(suggested&&!active?"suggest-pulse ":"")+cls}>{suggested&&<span style={{position:"absolute",top:"-5px",right:"-4px",background:"#6ee7b7",color:"#ffffff",fontSize:"9px",fontWeight:900,borderRadius:"999px",padding:"1px 4px",lineHeight:1.4}}>★</span>}{children}</button>;
}
function TabBtn({active,icon,label,onClick}){return <button onClick={onClick} className={"rounded-2xl px-2 py-2 text-[10px] font-black transition active:scale-95 sm:text-[11px] "+(active?"bg-amber-400 text-[#ffffff]":"text-gray-400")}><span className="mr-1">{icon}</span>{label}</button>;}
function StatCard({label,value,sub=""}){return <Card className="p-3"><p className="text-[10px] uppercase tracking-[0.14em] text-gray-400">{label}</p><p className="mt-1 text-xl font-black">{value}</p>{sub&&<p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}</Card>;}
function RecenterMap({center,zoom=17,enabled=true}){const map=useMap();useEffect(()=>{if(center&&enabled)map.setView(center,zoom,{animate:true});},[center,zoom,map,enabled]);return null;}
function FitBounds({shots,currentShot,enabled=true}){const map=useMap();useEffect(()=>{if(!enabled)return;const pts=[];if(currentShot?.start)pts.push([currentShot.start.lat,currentShot.start.lng]);shots.forEach(s=>{if(s.start)pts.push([s.start.lat,s.start.lng]);if(s.end)pts.push([s.end.lat,s.end.lng]);});if(pts.length>=2)map.fitBounds(pts,{padding:[40,40],maxZoom:18});},[shots,currentShot,enabled,map]);return null;}

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({data,color="#b45309",height=56,invert=false}){
  if(!data||data.length<2)return <div style={{height}} className="flex items-center justify-center text-xs text-gray-400">Not enough data yet</div>;
  const W=300,H=height,min=Math.min(...data),max=Math.max(...data),range=max-min||1,pad=6;
  const pts=data.map((v,i)=>{const x=(i/(data.length-1))*(W-pad*2)+pad;const norm=invert?1-(v-min)/range:(v-min)/range;return[x,H-pad-norm*(H-pad*2)];});
  const last=pts[pts.length-1];
  return <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height}} preserveAspectRatio="none"><polyline points={pts.map(p=>p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>{pts.map(([x,y],i)=><circle key={i} cx={x} cy={y} r="3" fill={color}/>)}<circle cx={last[0]} cy={last[1]} r="5" fill={color}/></svg>;
}

// ─── Course Search Panel ──────────────────────────────────────────────────────
function CourseSearchPanel({onCourseSelected,selectedCourse}){
  const [query,setQuery]=useState(""); const [results,setResults]=useState([]); const [loading,setLoading]=useState(false); const [err,setErr]=useState("");
  async function search(){if(!query.trim())return;setLoading(true);setErr("");setResults([]);try{const d=await apiSearchCourses(query.trim());const l=d.courses??d.results??d??[];setResults(Array.isArray(l)?l.slice(0,6):[]);if(!l.length)setErr("No courses found.");}catch{setErr("Search failed. Check connection.");}finally{setLoading(false);}}
  async function select(r){const id=r.id??r.course_id??r.courseId;setLoading(true);setErr("");try{if(id){const d=await apiFetchCourse(id);onCourseSelected({raw:r,detail:d,holes:extractHoles(d)});}else{onCourseSelected({raw:r,holes:[]});}setResults([]);setQuery("");}catch{setErr("Could not load course data.");}finally{setLoading(false);}}
  if(selectedCourse)return <div className="mb-4 rounded-2xl border border-[#15803d]/20 bg-[#15803d]/10 p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#15803d]">Course Loaded ✓</p><p className="mt-0.5 font-black">{extractCourseName(selectedCourse.raw)}</p><p className="text-xs text-gray-400">{selectedCourse.holes.length>0?`${selectedCourse.holes.length} holes · GPS active`:"Loaded · No GPS hole data"}</p></div><button onClick={()=>onCourseSelected(null)} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-bold text-gray-700 active:scale-95">Change</button></div></div>;
  return <div className="mb-4"><p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-gray-400">Find Your Course (Optional)</p><div className="flex gap-2"><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()} placeholder="e.g. Carlisle Country Club" className="flex-1 rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-sm text-white placeholder:text-gray-400 outline-none"/><button onClick={search} disabled={loading} className="h-12 w-12 rounded-2xl bg-amber-400 text-lg font-black text-[#ffffff] disabled:opacity-50 active:scale-95">{loading?"…":"🔍"}</button></div>{err&&<p className="mt-2 text-xs text-red-500">{err}</p>}{results.length>0&&<div className="mt-2 space-y-2">{results.map((r,i)=><button key={r.id??i} onClick={()=>select(r)} className="w-full rounded-2xl border border-gray-200 bg-white p-3 text-left active:scale-[0.98]"><p className="text-sm font-black">{extractCourseName(r)}</p><p className="text-xs text-gray-400">{r.location?.city?`${r.location.city}, `:""}{r.location?.state??r.city??""}</p></button>)}</div>}</div>;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function TracerBuddyApp() {
  const [roundStarted,setRoundStarted]=useState(false);
  const [activeTab,setActiveTab]=useState("track");
  const [club,setClub]=useState("Driver");
  const [shotShape,setShotShape]=useState("Straight");
  const [lie,setLie]=useState("Tee");
  const [result,setResult]=useState("Good");
  const [note,setNote]=useState("");
  const [currentShot,setCurrentShot]=useState(null);
  const [shots,setShots]=useState([]);
  const [scores,setScores]=useState(()=>Object.fromEntries(HOLES.map(h=>[h,{...BLANK_SCORE}])));
  const [status,setStatus]=useState("Ready when you are.");
  const [loading,setLoading]=useState(false);
  const [hole,setHole]=useState(1);
  const [mapMode,setMapMode]=useState("hole");
  const [autoFitMap,setAutoFitMap]=useState(true);
  const [selectedCourse,setSelectedCourse]=useState(null);
  const [livePosition,setLivePosition]=useState(null);
  const [allTimeShots,setAllTimeShots]=useState([]);
  const [roundHistory,setRoundHistory]=useState([]);
  const [weatherData,setWeatherData]=useState(null);
  const [weatherLoading,setWeatherLoading]=useState(false);
  const [shareRound,setShareRound]=useState(null);
  const [isOnline,setIsOnline]=useState(navigator.onLine);
  const [splashVisible,setSplashVisible]=useState(true);
  const [splashFading,setSplashFading]=useState(false);
  const [displayedDistance,setDisplayedDistance]=useState(null);
  const [distancePopKey,setDistancePopKey]=useState(0);
  const [autoDetect,setAutoDetect]=useState({state:"idle",course:null,distMiles:null,loading:false});
  const watchRef=useRef(null);
  const distanceAnimRef=useRef(null);

  // ── Restore ──
  useEffect(()=>{
    const s=localStorage.getItem("tracerbuddy_shots");
    const sc=localStorage.getItem("tracerbuddy_scores");
    const r=localStorage.getItem("tracerbuddy_round_started");
    const h=localStorage.getItem("tracerbuddy_hole");
    const c=localStorage.getItem("tracerbuddy_selected_course");
    const at=localStorage.getItem("tracerbuddy_all_time_shots");
    const rh=localStorage.getItem("tracerbuddy_round_history");
    if(s)setShots(JSON.parse(s));
    if(sc){const parsed=JSON.parse(sc);const merged=Object.fromEntries(HOLES.map(h=>[h,{...BLANK_SCORE,...(parsed[h]||{})}]));setScores(merged);}
    if(r==="true")setRoundStarted(true);
    if(h)setHole(Number(h));
    if(c)setSelectedCourse(JSON.parse(c));
    if(at)setAllTimeShots(JSON.parse(at));
    if(rh)setRoundHistory(JSON.parse(rh));
  },[]);

  // ── Persist ──
  useEffect(()=>localStorage.setItem("tracerbuddy_shots",JSON.stringify(shots)),[shots]);
  useEffect(()=>localStorage.setItem("tracerbuddy_scores",JSON.stringify(scores)),[scores]);
  useEffect(()=>{localStorage.setItem("tracerbuddy_round_started",String(roundStarted));localStorage.setItem("tracerbuddy_hole",String(hole));},[roundStarted,hole]);
  useEffect(()=>{if(selectedCourse)localStorage.setItem("tracerbuddy_selected_course",JSON.stringify(selectedCourse));else localStorage.removeItem("tracerbuddy_selected_course");},[selectedCourse]);
  useEffect(()=>localStorage.setItem("tracerbuddy_all_time_shots",JSON.stringify(allTimeShots)),[allTimeShots]);
  useEffect(()=>localStorage.setItem("tracerbuddy_round_history",JSON.stringify(roundHistory)),[roundHistory]);

  // ── Splash screen ──
  useEffect(()=>{
    const t=setTimeout(()=>{
      setSplashFading(true);
      setTimeout(()=>setSplashVisible(false),500);
    },2200);
    return()=>clearTimeout(t);
  },[]);

  // ── Animated distance countdown ──
  useEffect(()=>{
    if(distanceToPin===null){setDisplayedDistance(null);return;}
    if(displayedDistance===null){setDisplayedDistance(distanceToPin);setDistancePopKey(k=>k+1);return;}
    if(distanceAnimRef.current)cancelAnimationFrame(distanceAnimRef.current);
    const start=displayedDistance,end=distanceToPin;
    if(start===end)return;
    setDistancePopKey(k=>k+1);
    const dur=450,t0=performance.now();
    const tick=now=>{
      const p=Math.min((now-t0)/dur,1);
      const e=1-Math.pow(1-p,3);
      setDisplayedDistance(Math.round(start+(end-start)*e));
      if(p<1)distanceAnimRef.current=requestAnimationFrame(tick);
    };
    distanceAnimRef.current=requestAnimationFrame(tick);
    return()=>{if(distanceAnimRef.current)cancelAnimationFrame(distanceAnimRef.current);};
  },[distanceToPin]);

  // ── Online/Offline ──
  useEffect(()=>{const on=()=>setIsOnline(true);const off=()=>setIsOnline(false);window.addEventListener("online",on);window.addEventListener("offline",off);return()=>{window.removeEventListener("online",on);window.removeEventListener("offline",off);};},[]);

  // ── Weather fetch (with offline cache) ──
  useEffect(()=>{
    if(roundStarted||!navigator.geolocation)return;
    // Try cache first if offline
    const cached=localStorage.getItem("tracerbuddy_weather_cache");
    if(cached){const p=JSON.parse(cached);if(Date.now()-p.cachedAt<7200000){setWeatherData(p);return;}}
    setWeatherLoading(true);
    navigator.geolocation.getCurrentPosition(async pos=>{
      try{const d=await fetchWeatherAndElevation(pos.coords.latitude,pos.coords.longitude);setWeatherData(d);localStorage.setItem("tracerbuddy_weather_cache",JSON.stringify({...d,cachedAt:Date.now()}));}
      catch{const fb=localStorage.getItem("tracerbuddy_weather_cache");if(fb)setWeatherData(JSON.parse(fb));}
      finally{setWeatherLoading(false);}
    },()=>setWeatherLoading(false),{enableHighAccuracy:false,timeout:8000});
  },[roundStarted]);

  // ── Live GPS ──
  useEffect(()=>{
    if(!roundStarted||!navigator.geolocation)return;
    watchRef.current=navigator.geolocation.watchPosition(p=>setLivePosition({lat:p.coords.latitude,lng:p.coords.longitude}),null,{enableHighAccuracy:true,maximumAge:3000,timeout:15000});
    return()=>{if(watchRef.current!=null)navigator.geolocation.clearWatch(watchRef.current);};
  },[roundStarted]);

  // ── Auto-detect nearby course ──
  useEffect(()=>{
    if(roundStarted||selectedCourse||autoDetect.state!=="idle"||!navigator.geolocation)return;
    setAutoDetect(p=>({...p,state:"detecting"}));
    navigator.geolocation.getCurrentPosition(async pos=>{
      try{
        const c=await autoDetectNearby(pos.coords.latitude,pos.coords.longitude);
        setAutoDetect({state:"found",course:c,distMiles:c.distMiles,loading:false});
      }catch{
        setAutoDetect({state:"idle",course:null,distMiles:null,loading:false});
      }
    },()=>setAutoDetect({state:"idle",course:null,distMiles:null,loading:false}),{enableHighAccuracy:false,timeout:10000});
  },[roundStarted,selectedCourse,autoDetect.state]);

  // ── Course hole data ──
  const currentHoleData=useMemo(()=>{if(!selectedCourse?.holes?.length)return null;return selectedCourse.holes.find(h=>Number(h.hole_number??h.holeNumber??h.number??h.hole)===hole)??null;},[selectedCourse,hole]);
  const greenLocation=useMemo(()=>extractGreen(currentHoleData),[currentHoleData]);
  const distanceToPin=useMemo(()=>{if(!livePosition||!greenLocation)return null;return yardsBetween(livePosition,greenLocation);},[livePosition,greenLocation]);

  // ── Adjusted distance (elevation + wind) ──
  const adjustedDistance=useMemo(()=>{
    if(distanceToPin==null)return null;
    let adj=distanceToPin;
    if(weatherData?.elevationFt){const m=1+(weatherData.elevationFt/1000)*0.02;adj=Math.round(adj/m);}
    if(weatherData?.windSpeed>2&&livePosition&&greenLocation){adj+=windAdj(weatherData.windSpeed,weatherData.windDir,bearingTo(livePosition,greenLocation));}
    return adj;
  },[distanceToPin,weatherData,livePosition,greenLocation]);

  // ── Club averages & suggestion ──
  const clubAverages=useMemo(()=>{const m={};CLUBS.forEach(n=>{const l=allTimeShots.filter(s=>s.club===n&&s.distance>0);m[n]=l.length>=MIN_SHOTS?Math.round(l.reduce((s,x)=>s+x.distance,0)/l.length):DEFAULT_CLUB_DIST[n];});return m;},[allTimeShots]);
  const clubDataSource=useMemo(()=>{const m={};CLUBS.forEach(n=>{m[n]=allTimeShots.filter(s=>s.club===n&&s.distance>0).length>=MIN_SHOTS;});return m;},[allTimeShots]);
  const suggestedClub=useMemo(()=>{const t=adjustedDistance??distanceToPin;if(t==null)return null;const el=CLUBS.filter(c=>c!=="Putter"||t<30);let best=null,bd=Infinity;el.forEach(n=>{const d=Math.abs((clubAverages[n]??999)-t);if(d<bd){bd=d;best=n;}});return best;},[adjustedDistance,distanceToPin,clubAverages]);

  // ── Session stats ──
  const totalDistance=useMemo(()=>shots.reduce((s,x)=>s+(x.distance||0),0),[shots]);
  const longest=useMemo(()=>shots.reduce((b,s)=>s.distance>(b?.distance||0)?s:b,null),[shots]);
  const avgDistance=useMemo(()=>shots.length?Math.round(totalDistance/shots.length):0,[shots,totalDistance]);
  const goodRate=useMemo(()=>shots.length?Math.round(shots.filter(s=>s.result==="Good").length/shots.length*100):0,[shots]);

  // ── Score totals ──
  const scoreTotals=useMemo(()=>{
    let strokes=0,played=0,pp=0,putts=0,penalties=0,firH=0,firT=0,girH=0,girT=0;
    HOLES.forEach(h=>{
      const r=scores[h]||BLANK_SCORE;
      const s=Number(r.strokes);
      if(s>0){strokes+=s;played++;pp+=Number(r.par)||4;}
      putts+=Number(r.putts)||0;
      penalties+=Number(r.penalties)||0;
      if(r.par>=4&&r.fir!==null){firT++;if(r.fir===true)firH++;}
      girT++;if(r.gir===true)girH++;
    });
    return{strokes,played,toPar:strokes?strokes-pp:0,putts,penalties,firH,firT,girH,girT,firPct:firT?Math.round(firH/firT*100):null,girPct:girT?Math.round(girH/girT*100):null};
  },[scores]);

  // ── Strokes gained ──
  const strokesGained=useMemo(()=>{
    let sgPar=0,sgParHoles=0;
    const holeAvgs={};
    HOLES.forEach(h=>{
      const prev=roundHistory.filter(r=>r.holeScores?.[h]).map(r=>Number(r.holeScores[h]));
      if(prev.length>=2)holeAvgs[h]=prev.reduce((a,b)=>a+b)/prev.length;
    });
    let sgAvg=0,sgAvgHoles=0;
    HOLES.forEach(h=>{
      const r=scores[h]||BLANK_SCORE;
      const s=Number(r.strokes);
      if(s>0){sgPar+=r.par-s;sgParHoles++;}
      if(s>0&&holeAvgs[h]){sgAvg+=holeAvgs[h]-s;sgAvgHoles++;}
    });
    return{sgPar:Math.round(sgPar*10)/10,sgAvg:Math.round(sgAvg*10)/10,sgAvgHoles,holeAvgs};
  },[scores,roundHistory]);

  // ── Miss tendency ──
  const missTendency=useMemo(()=>{
    return CLUBS.map(name=>{
      const l=allTimeShots.filter(s=>s.club===name);
      if(l.length<5)return null;
      const counts={Left:0,Right:0,Short:0,Long:0};
      l.forEach(s=>{if(counts[s.result]!==undefined)counts[s.result]++;});
      const total=l.length;
      const goodPct=Math.round(l.filter(s=>s.result==="Good").length/total*100);
      const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
      const [topDir,topCount]=sorted[0];
      if(topCount/total<0.25)return null;
      return{name,dir:topDir,pct:Math.round(topCount/total*100),goodPct,total};
    }).filter(Boolean);
  },[allTimeShots]);

  // ── Club gapping ──
  const clubGaps=useMemo(()=>{
    const wd=CLUBS.map(n=>{const l=allTimeShots.filter(s=>s.club===n&&s.distance>0);if(l.length<MIN_SHOTS)return null;return{name:n,avg:Math.round(l.reduce((s,x)=>s+x.distance,0)/l.length),count:l.length};}).filter(Boolean).sort((a,b)=>b.avg-a.avg);
    const gaps=[];for(let i=0;i<wd.length-1;i++){const g=wd[i].avg-wd[i+1].avg;if(g>20)gaps.push({high:wd[i],low:wd[i+1],gap:g});}
    return{clubs:wd,gaps};
  },[allTimeShots]);

  // ── Stat trends ──
  const statTrends=useMemo(()=>{
    const rounds=[...roundHistory].reverse().slice(0,10);
    return{
      toPar:rounds.filter(r=>r.strokes>0).map(r=>r.toPar),
      longestDrive:rounds.filter(r=>r.longestDrive>0).map(r=>r.longestDrive),
      goodPct:rounds.map(r=>{const rs=allTimeShots.filter(s=>Math.abs(new Date(s.finishedAt||s.startedAt)-new Date(r.date))<86400000);if(!rs.length)return null;return Math.round(rs.filter(s=>s.result==="Good").length/rs.length*100);}).filter(v=>v!==null),
      puttsPerRound:rounds.filter(r=>r.totalPutts>0).map(r=>r.totalPutts),
    };
  },[roundHistory,allTimeShots]);

  // ── Club stats (current round) ──
  const clubStats=useMemo(()=>CLUBS.map(n=>{const l=shots.filter(s=>s.club===n&&s.distance>0);const avg=l.length?Math.round(l.reduce((s,x)=>s+x.distance,0)/l.length):0;return{name:n,count:l.length,avg,best:l.reduce((m,s)=>Math.max(m,s.distance),0)};}).filter(r=>r.count>0),[shots]);

  // ── Map ──
  const lastLocation=currentShot?.start||shots[0]?.end||shots[0]?.start;
  const mapCenter=lastLocation?[lastLocation.lat,lastLocation.lng]:[40.2015,-77.1890];
  const visibleShots=useMemo(()=>mapMode==="hole"?shots.filter(s=>s.hole===hole):shots,[shots,hole,mapMode]);
  const shotLines=useMemo(()=>visibleShots.filter(s=>s.start&&s.end).map(s=>({id:s.id,positions:[[s.start.lat,s.start.lng],[s.end.lat,s.end.lng]]})),[visibleShots]);
  const visibleDist=useMemo(()=>visibleShots.reduce((s,x)=>s+(x.distance||0),0),[visibleShots]);

  // ── Handlers ──
  function handleCourseSelected(course){
    setSelectedCourse(course);
    if(course?.holes?.length){setScores(prev=>{const u={...prev};course.holes.forEach(h=>{const n=Number(h.hole_number??h.holeNumber??h.number??h.hole);if(n>=1&&n<=18)u[n]={...u[n],par:extractPar(h)};});return u;});}
  }
  function startRound(){setRoundStarted(true);setActiveTab("track");setStatus("Round started. Choose your club and tap Hit Shot.");}
  async function hitShot(){setLoading(true);setStatus("Locking your hit position...");try{const loc=await getLocation();setCurrentShot({id:crypto.randomUUID(),club,shotShape,lie,result,note,hole,start:loc,startedAt:loc.time});setStatus(`Shot marked with ${club}. Walk to ball, then tap Ball Found Here.`);}catch{setStatus("GPS failed. Turn on location permission and try again.");}finally{setLoading(false);}}
  async function ballFound(){if(!currentShot){setStatus("Tap Hit Shot first.");return;}setLoading(true);setStatus("Locking ball location...");try{const end=await getLocation();const dist=yardsBetween(currentShot.start,end);setShots(prev=>[{...currentShot,result,note,end,distance:dist,finishedAt:end.time},...prev]);setCurrentShot(null);setNote("");setStatus(`${currentShot.club} saved: ${dist} yards.`);}catch{setStatus("GPS failed. Stand still and try again.");}finally{setLoading(false);}}
  function openMaps(pt){if(!pt)return;window.open(`https://www.google.com/maps/search/?api=1&query=${pt.lat},${pt.lng}`,"_blank");}
  function lostBall(){if(!currentShot){setStatus("No active shot.");return;}openMaps(currentShot.start);setStatus("Opened last hit location in Maps.");}
  function updateScore(h,field,value){setScores(prev=>({...prev,[h]:{...(prev[h]||BLANK_SCORE),[field]:value}}));}

  function clearRound(){
    const done=shots.filter(s=>s.distance>0);
    if(done.length>0)setAllTimeShots(prev=>[...prev,...done]);
    if(scoreTotals.played>0||done.length>0){
      const best=done.reduce((b,s)=>s.distance>(b?.distance||0)?s:b,null);
      const holeScores={};HOLES.forEach(h=>{if(scores[h]?.strokes)holeScores[h]=scores[h].strokes;});
      setRoundHistory(prev=>[{
        id:crypto.randomUUID(),date:new Date().toISOString(),
        courseName:selectedCourse?extractCourseName(selectedCourse.raw):"Unknown Course",
        holesPlayed:scoreTotals.played,strokes:scoreTotals.strokes,toPar:scoreTotals.toPar,
        shotsTracked:done.length,longestDrive:best?.distance??0,longestClub:best?.club??"",
        elevationFt:weatherData?.elevationFt??null,holeScores,
        totalPutts:scoreTotals.putts,firH:scoreTotals.firH,firT:scoreTotals.firT,girH:scoreTotals.girH,girT:scoreTotals.girT,
      },...prev]);
    }
    setShots([]);setCurrentShot(null);setHole(1);
    setScores(Object.fromEntries(HOLES.map(h=>[h,{...BLANK_SCORE}])));
    setSelectedCourse(null);setRoundStarted(false);setActiveTab("track");setStatus("Ready when you are.");
    setAutoDetect({state:"idle",course:null,distMiles:null,loading:false});
    ["tracerbuddy_shots","tracerbuddy_scores","tracerbuddy_round_started","tracerbuddy_hole","tracerbuddy_selected_course"].forEach(k=>localStorage.removeItem(k));
  }

  // ── Pre-round screen ──────────────────────────────────────────────────────────
  if(!roundStarted){
    return (
      <div className="min-h-screen bg-[#f9fafb] px-4 py-6 text-white">
        <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-md flex-col justify-between">
          <div>
            <div className="mb-6 flex items-center justify-between pt-2">
              <div><div className="text-3xl font-black tracking-tight"><span className="text-[#15803d]">Tracer</span><span className="text-amber-700">Buddy</span></div><p className="text-sm text-gray-400">The smarter way to track every shot.</p></div>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400 text-2xl shadow-lg shadow-black/40">⛳</div>
            </div>
            {!isOnline&&<div className="mb-4 rounded-2xl bg-red-50 border border-red-400/30 px-4 py-3 text-xs font-black text-red-500">⚡ Offline mode — using cached course &amp; weather data</div>}
            <Card className="overflow-hidden p-0 mb-4"><div className="bg-gradient-to-br from-emerald-400/25 via-white/5 to-amber-300/20 p-5"><div className="mb-4 flex h-20 items-center justify-center rounded-2xl border border-gray-200 bg-gray-50 text-5xl">🎯</div><h1 className="text-3xl font-black leading-tight">Ready for the course?</h1><p className="mt-2 text-sm leading-6 text-gray-600">Live distance to pin · Club AI · Round history · Stats</p></div></Card>
            <CourseSearchPanel onCourseSelected={c=>{handleCourseSelected(c);setAutoDetect(p=>({...p,state:"dismissed"}));}} selectedCourse={selectedCourse}/>

            {/* Auto-detect banner */}
            {autoDetect.state==="detecting"&&!selectedCourse&&(
              <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4">
                <div className="flex items-center gap-3">
                  <div style={{animation:"splashDot 1s ease-in-out infinite"}} className="text-xl">📡</div>
                  <div><p className="text-sm font-black text-white">Detecting your course...</p><p className="text-xs text-gray-400">Checking what's near your GPS location</p></div>
                </div>
              </div>
            )}
            {autoDetect.state==="found"&&!selectedCourse&&(
              <div className="mb-4 rounded-2xl border border-[#b45309]/30 bg-amber-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-700 mb-1">Detected Nearby · {autoDetect.distMiles} mi away</p>
                <p className="font-black text-white text-base mb-0.5">{extractCourseName(autoDetect.course)}</p>
                <p className="text-xs text-gray-400 mb-3">
                  {[autoDetect.course?.location?.city||autoDetect.course?.city, autoDetect.course?.location?.state||autoDetect.course?.state].filter(Boolean).join(", ")}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    className="btn-action h-11 rounded-2xl bg-[#15803d] text-sm font-black text-[#ffffff]"
                    onClick={async()=>{
                      setAutoDetect(p=>({...p,loading:true}));
                      try{
                        const id=autoDetect.course?.id??autoDetect.course?.course_id??autoDetect.course?.courseId;
                        if(id){const d=await apiFetchCourse(id);handleCourseSelected({raw:autoDetect.course,detail:d,holes:extractHoles(d)});}
                        else{handleCourseSelected({raw:autoDetect.course,holes:[]});}
                        setAutoDetect(p=>({...p,state:"dismissed",loading:false}));
                      }catch{setAutoDetect(p=>({...p,loading:false}));}
                    }}
                  >
                    {autoDetect.loading?"Loading...":"Yes, that's it ✓"}
                  </button>
                  <button
                    className="btn-action h-11 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700"
                    onClick={()=>setAutoDetect(p=>({...p,state:"dismissed"}))}
                  >
                    Not my course
                  </button>
                </div>
              </div>
            )}
            {(weatherData||weatherLoading)&&(
              <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4">
                {weatherLoading?<p className="text-xs text-gray-400 text-center">Fetching course conditions...</p>:weatherData&&(
                  <><p className="text-[10px] font-black uppercase tracking-[0.18em] text-gray-400 mb-2">Course Conditions{!isOnline?" · Cached":""}</p>
                  <div className="grid grid-cols-4 gap-2">
                    {[["WIND",`${weatherData.windSpeed}mph`],["DIR",windDirLabel(weatherData.windDir)],["TEMP",`${weatherData.tempF}°F`],["ELEV",`${weatherData.elevationFt}ft`]].map(([l,v])=><div key={l} className="rounded-2xl bg-gray-50 p-2 text-center"><p className="text-[9px] text-gray-400">{l}</p><p className="text-sm font-black">{v}</p></div>)}
                  </div>
                  <p className="mt-2 text-center text-xs text-gray-400">{weatherLabel(weatherData.weatherCode)} · Club suggestions auto-adjusted</p></>
                )}
              </div>
            )}
          </div>
          <div className="pb-4"><button onClick={startRound} style={{height:60,width:"100%",borderRadius:16,background:"#15803d",fontSize:16,fontWeight:900,color:"#ffffff",letterSpacing:"0.04em",border:"none",textTransform:"uppercase"}} className="btn-action">Start Round</button><p className="mt-3 text-center text-xs text-gray-400">Best used outdoors with location permission on.</p></div>
        </div>
      </div>
    );
  }

  // ── Main round screen ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f9fafb] text-white">
      <div className="mx-auto max-w-md">
        {!isOnline&&<div className="bg-red-50 border-b border-red-400/30 px-4 py-2 text-xs font-black text-red-500 text-center">⚡ Offline — GPS still works</div>}

        {/* Header */}
        <div className="sticky top-0 z-20 border-b border-gray-200 bg-[#f9fafb]/95 px-4 pb-3 pt-4 ">
          <div className="flex items-center justify-between">
            <div><div className="text-2xl font-black tracking-tight"><span className="text-[#15803d]">Tracer</span><span className="text-amber-700">Buddy</span></div><p className="text-xs text-gray-400 truncate max-w-[200px]">{selectedCourse?extractCourseName(selectedCourse.raw):"No course loaded"}</p></div>
            <div className="rounded-2xl border border-[#b45309]/30 bg-amber-50 px-3 py-2 text-sm font-black text-amber-700/80">Hole {hole}</div>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-2xl bg-gray-50 p-1">
            <TabBtn active={activeTab==="track"} icon="📍" label="Track" onClick={()=>setActiveTab("track")}/>
            <TabBtn active={activeTab==="map"} icon="🗺️" label="Map" onClick={()=>setActiveTab("map")}/>
            <TabBtn active={activeTab==="score"} icon="⛳" label="Score" onClick={()=>setActiveTab("score")}/>
            <TabBtn active={activeTab==="history"} icon="📊" label="Stats" onClick={()=>setActiveTab("history")}/>
          </div>
        </div>

        <main className="space-y-4 px-4 py-4 pb-8">

          {/* ── TRACK TAB ── */}
          {activeTab==="track"&&(
            <div className="tab-content space-y-4">
              {greenLocation&&(
                <div style={{background:"#ffffff",border:"1px solid rgba(0,0,0,0.08)",borderTop:"2px solid #15803d",borderRadius:"20px",padding:"18px 18px 14px"}}>
                  <p style={{fontSize:10,fontWeight:900,letterSpacing:"0.22em",color:"rgba(0,0,0,0.2)",textTransform:"uppercase",margin:"0 0 8px"}}>Distance to Pin · Hole {hole}</p>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                      <span key={distancePopKey} className="distance-pop num-display" style={{fontSize:72,fontWeight:900,color:"#15803d",lineHeight:1,letterSpacing:"-2px"}}>{displayedDistance??"-"}</span>
                      <span style={{fontSize:18,fontWeight:700,color:"rgba(0,0,0,0.15)"}}>yds</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                      {livePosition&&<div style={{display:"flex",alignItems:"center",gap:5,background:"rgba(21,128,61,0.08)",border:"1px solid rgba(21,128,61,0.1)",borderRadius:999,padding:"4px 10px"}}><div className="live-dot" style={{width:6,height:6,borderRadius:"50%",background:"#15803d"}}/><span style={{fontSize:10,fontWeight:700,color:"#15803d"}}>Live GPS</span></div>}
                      {currentHoleData&&<span style={{fontSize:11,color:"rgba(0,0,0,0.3)",fontWeight:600}}>Par {extractPar(currentHoleData)}</span>}
                    </div>
                  </div>
                  {distanceToPin!=null&&(
                    <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(0,0,0,0.05)"}}>
                      {suggestedClub?(
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                          <div>
                            <span style={{fontSize:11,fontWeight:900,color:"#15803d"}}>★ Suggested club</span>
                            {adjustedDistance!=null&&adjustedDistance!==distanceToPin&&<p style={{fontSize:10,color:"rgba(0,0,0,0.2)",margin:"2px 0 0"}}>{distanceToPin}y → {adjustedDistance}y adjusted{weatherData?.windSpeed>2?` · ${weatherData.windSpeed}mph ${windDirLabel(weatherData.windDir)}`:""}</p>}
                          </div>
                          <div style={{background:"rgba(180,83,9,0.08)",border:"1px solid rgba(180,83,9,0.25)",borderRadius:10,padding:"6px 14px",fontSize:13,fontWeight:900,color:"#92400e"}}>{suggestedClub}</div>
                        </div>
                      ):(<p style={{fontSize:11,color:"rgba(0,0,0,0.15)"}}>Play more rounds to unlock club suggestions</p>)}
                    </div>
                  )}
                </div>
              )}

              <Card className="p-4">
                <div className="mb-4 flex items-center justify-between rounded-xl bg-gray-50 p-2">
                  <button onClick={()=>setHole(Math.max(1,hole-1))} className="h-11 w-14 rounded-2xl bg-gray-100 text-xl font-black active:scale-95">-</button>
                  <div className="text-center"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Current Hole</p><p className="text-3xl font-black">{hole}</p></div>
                  <button onClick={()=>setHole(Math.min(18,hole+1))} className="h-11 w-14 rounded-2xl bg-gray-100 text-xl font-black active:scale-95">+</button>
                </div>
                <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-gray-400">Club</p>
                <div className="grid grid-cols-3 gap-2">{CLUBS.map(item=><PillBtn key={item} active={club===item} suggested={suggestedClub===item} onClick={()=>setClub(item)}>{item}</PillBtn>)}</div>
                <p className="mb-2 mt-4 text-[10px] font-black uppercase tracking-[0.22em] text-gray-400">Shot Type</p>
                <div className="grid grid-cols-4 gap-2">{SHOT_SHAPES.map(item=><PillBtn key={item} active={shotShape===item} tone="green" onClick={()=>setShotShape(item)}>{item}</PillBtn>)}</div>
                <p className="mb-2 mt-4 text-[10px] font-black uppercase tracking-[0.22em] text-gray-400">Lie</p>
                <div className="grid grid-cols-3 gap-2">{LIES.map(item=><PillBtn key={item} active={lie===item} tone="white" onClick={()=>setLie(item)}>{item}</PillBtn>)}</div>
              </Card>

              <Card className="overflow-hidden p-0">
                <div className="bg-gradient-to-br from-emerald-400/15 to-amber-300/10 p-5">
                  <div className="mb-4 rounded-2xl border border-[#15803d]/15 bg-[#ffffff] p-4 text-center"><div className="mb-2 text-5xl">🎯</div><p className="font-black">GPS Shot Tracker</p><p className="mt-1 text-xs leading-5 text-gray-400">Stand still for a second when marking shots.</p></div>
                  <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">{loading?"Working...":status}</div>
                  <div className="mt-4"><p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-gray-400">Result</p><div className="grid grid-cols-4 gap-2">{RESULTS.map(item=><PillBtn key={item} active={result===item} onClick={()=>setResult(item)}>{item}</PillBtn>)}</div><input value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional note: wind, contact, target..." className="mt-3 w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-sm text-white placeholder:text-gray-400 outline-none"/></div>
                  <div className="mt-4 grid grid-cols-1 gap-3">
                    <button disabled={loading} onClick={hitShot} style={{height:58,borderRadius:16,background:"#15803d",fontSize:15,fontWeight:900,color:"#f9fafb",letterSpacing:"0.02em",border:"none"}} className="btn-action disabled:opacity-40">📍 Hit Shot</button>
                    <button disabled={loading} onClick={ballFound} style={{height:58,borderRadius:16,background:"#b45309",fontSize:15,fontWeight:900,color:"#f9fafb",letterSpacing:"0.02em",border:"none"}} className="btn-action disabled:opacity-40">✅ Ball Found Here</button>
                    <button onClick={lostBall} style={{height:44,borderRadius:14,background:"rgba(0,0,0,0.03)",border:"1px solid rgba(0,0,0,0.07)",fontSize:12,fontWeight:600,color:"rgba(0,0,0,0.45)"}} className="btn-action">⚠ Lost Ball / Open Last Hit Spot</button>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* ── MAP TAB ── */}
          {activeTab==="map"&&(
            <div className="tab-content">
            <Card className="overflow-hidden p-0">
                <div className="mb-4 flex items-center justify-between"><div><p className="text-xs uppercase tracking-[0.22em] text-gray-400">Satellite Map</p><h2 className="text-2xl font-black">{mapMode==="hole"?`Hole ${hole}`:"Full Round"}</h2></div><div className="rounded-2xl bg-gray-50 px-3 py-2 text-xs font-black text-amber-700/80">GPS ±{lastLocation?.accuracy||"-"}m</div></div>
                {distanceToPin!=null&&<div className="mb-3 flex items-center justify-between rounded-2xl border border-[#15803d]/15 bg-[#15803d]/10 p-3"><span className="text-xs font-black text-[#15803d]">Distance to Pin</span><span className="text-2xl font-black text-amber-700">{distanceToPin} yds</span></div>}
                <div className="mb-3 grid grid-cols-3 gap-2">
                  {[["Shots",visibleShots.length],["Lines",shotLines.length],["Yards",visibleDist||"-"]].map(([l,v])=><div key={l} className="rounded-2xl border border-gray-200 bg-gray-50 p-3"><p className="text-[10px] text-gray-400">{l}</p><p className="text-lg font-black">{v}</p></div>)}
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 rounded-2xl bg-gray-50 p-1">
                  <button onClick={()=>setMapMode("hole")} className={"rounded-xl py-2 text-xs font-black "+(mapMode==="hole"?"bg-amber-400 text-[#ffffff]":"text-gray-600")}>Current Hole</button>
                  <button onClick={()=>setMapMode("round")} className={"rounded-xl py-2 text-xs font-black "+(mapMode==="round"?"bg-amber-400 text-[#ffffff]":"text-gray-600")}>Full Round</button>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 rounded-2xl bg-gray-50 p-1">
                  <button onClick={()=>setAutoFitMap(true)} className={"rounded-xl py-2 text-xs font-black "+(autoFitMap?"bg-emerald-300 text-[#ffffff]":"text-gray-600")}>Auto Fit</button>
                  <button onClick={()=>setAutoFitMap(false)} className={"rounded-xl py-2 text-xs font-black "+(!autoFitMap?"bg-emerald-300 text-[#ffffff]":"text-gray-600")}>Free Move</button>
                </div>
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50">
                  <div style={{height:430,width:"100%"}}>
                    <MapContainer center={mapCenter} zoom={17} scrollWheelZoom style={{height:"100%",width:"100%"}}>
                      <TileLayer attribution="Tiles © Esri" url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"/>
                      <RecenterMap center={mapCenter} zoom={17} enabled={!autoFitMap}/>
                      <FitBounds shots={visibleShots} currentShot={currentShot} enabled={autoFitMap}/>
                      {greenLocation&&mapMode==="hole"&&<Marker icon={makeGreenIcon()} position={[greenLocation.lat,greenLocation.lng]}><Popup>Hole {hole} Pin · Par {extractPar(currentHoleData)}{distanceToPin?` · ${distanceToPin} yds from you`:""}</Popup></Marker>}
                      {currentShot?.start&&<Marker icon={makeCurrentIcon()} position={[currentShot.start.lat,currentShot.start.lng]}><Popup>Current shot · {currentShot.club} · Hole {currentShot.hole}</Popup></Marker>}
                      {visibleShots.map((s,i)=><React.Fragment key={s.id}>{s.start&&<Marker icon={makeNumIcon(i+1,"start")} position={[s.start.lat,s.start.lng]}><Popup>Shot {i+1} · {s.club} · {fmtTime(s.startedAt)}</Popup></Marker>}{s.end&&<Marker icon={makeNumIcon(i+1,"end")} position={[s.end.lat,s.end.lng]}><Popup><strong>{s.club} · {s.distance}y</strong><br/>Hole {s.hole} · {s.result}</Popup></Marker>}</React.Fragment>)}
                      {shotLines.map(l=><Polyline key={l.id} positions={l.positions} pathOptions={{color:"#b45309",weight:5,opacity:0.95,dashArray:"8 8"}}/>)}
                    </MapContainer>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4"><p className="text-sm font-black">Last known point</p><p className="mt-1 text-xs text-gray-400">{lastLocation?`${lastLocation.lat.toFixed(5)}, ${lastLocation.lng.toFixed(5)}`:"No GPS point yet."}</p></div>
                  <div className="grid grid-cols-2 gap-3"><button onClick={()=>openMaps(lastLocation)} className="h-14 rounded-2xl bg-amber-400 text-sm font-black text-[#ffffff] active:scale-95">Open Maps</button><button onClick={lostBall} className="h-14 rounded-2xl bg-gray-100 text-sm font-black text-white active:scale-95">Find Ball</button></div>
                </div>
              </div>
            </div>
          )}

          {/* ── SCORE TAB ── */}
          {activeTab==="score"&&(
            <div className="tab-content space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Score" value={scoreTotals.strokes||"-"} sub={scoreTotals.strokes?(scoreTotals.toPar>0?`+${scoreTotals.toPar}`:scoreTotals.toPar===0?"Even":`${scoreTotals.toPar}`):"-"}/>
                <StatCard label="Putts" value={scoreTotals.putts||"-"} sub={scoreTotals.played?`${Math.round(scoreTotals.putts/scoreTotals.played*10)/10} per hole`:""}/>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatCard label="FIR %" value={scoreTotals.firPct!=null?`${scoreTotals.firPct}%`:"-"} sub={scoreTotals.firT?`${scoreTotals.firH}/${scoreTotals.firT} holes`:""}/>
                <StatCard label="GIR %" value={scoreTotals.girPct!=null?`${scoreTotals.girPct}%`:"-"} sub={scoreTotals.girT?`${scoreTotals.girH}/${scoreTotals.girT} holes`:""}/>
                <StatCard label="Penalties" value={scoreTotals.penalties||"0"}/>
              </div>
              {roundHistory.length>0&&(strokesGained.sgAvgHoles>0)&&(
                <Card className="p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-gray-400 mb-2">Strokes Gained</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-gray-50 p-3 text-center">
                      <p className="text-[10px] text-gray-400">vs Par</p>
                      <p className={`text-2xl font-black ${strokesGained.sgPar>0?"text-[#15803d]":strokesGained.sgPar<0?"text-red-500":"text-gray-900"}`}>{strokesGained.sgPar>0?"+":""}{strokesGained.sgPar}</p>
                    </div>
                    <div className="rounded-2xl bg-gray-50 p-3 text-center">
                      <p className="text-[10px] text-gray-400">vs Your Avg</p>
                      <p className={`text-2xl font-black ${strokesGained.sgAvg>0?"text-[#15803d]":strokesGained.sgAvg<0?"text-red-500":"text-gray-900"}`}>{strokesGained.sgAvg>0?"+":""}{strokesGained.sgAvg}</p>
                      <p className="text-[9px] text-gray-400">{strokesGained.sgAvgHoles} holes</p>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] text-gray-400 text-center">+ = gaining strokes (playing better than baseline)</p>
                </Card>
              )}
              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div><h2 className="text-lg font-black">Scorecard</h2><p className="text-xs text-gray-400">{selectedCourse?"Pars from course · tap hole to set active":"Tap +/− to score each hole"}</p></div>
                  <button onClick={()=>setScores(Object.fromEntries(HOLES.map(h=>[h,{...BLANK_SCORE}])))} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-bold text-gray-700">Reset</button>
                </div>

                {/* Column headers */}
                <div style={{display:"grid",gridTemplateColumns:"40px 1fr 80px 54px 32px",gap:"6px",alignItems:"center"}} className="mb-2 px-1">
                  <div className="text-[9px] text-gray-400 text-center font-black uppercase">#</div>
                  <div className="text-[9px] text-gray-400 text-center font-black uppercase">Strokes</div>
                  <div className="text-[9px] text-gray-400 text-center font-black uppercase">Putts</div>
                  <div className="text-[9px] text-gray-400 text-center font-black uppercase">F G</div>
                  <div className="text-[9px] text-gray-400 text-center font-black uppercase">⚠</div>
                </div>

                <div className="space-y-1.5">
                  {HOLES.map(h=>{
                    const r=scores[h]||BLANK_SCORE;
                    const s=Number(r.strokes)||0;
                    const sg=s>0?s-r.par:null;
                    const sgColor=sg!=null?(sg<0?"#6ee7b7":sg>0?"#f87171":"rgba(0,0,0,0.55)"):"transparent";
                    const isCurrent=hole===h;
                    return (
                      <div key={h}>
                        {/* Compact single row */}
                        <div
                          style={{
                            display:"grid",
                            gridTemplateColumns:"40px 1fr 80px 54px 32px",
                            gap:"6px",
                            alignItems:"center",
                            background: isCurrent ? "rgba(252,211,77,0.08)" : "rgba(0,0,0,0.2)",
                            border: isCurrent ? "1px solid rgba(252,211,77,0.2)" : "1px solid transparent",
                            borderRadius:"16px",
                            padding:"6px",
                          }}
                        >
                          {/* Hole number + to-par badge */}
                          <button
                            onClick={()=>setHole(h)}
                            style={{height:36,borderRadius:10,fontWeight:900,fontSize:13,position:"relative",background:isCurrent?"#fcd34d":"rgba(0,0,0,0.06)",color:isCurrent?"#ffffff":"rgba(0,0,0,0.65)"}}
                            className="active:scale-90 transition-transform"
                          >
                            {h}
                            {sg!=null&&(
                              <span style={{position:"absolute",top:-5,right:-5,background:sgColor,color:sg===0?"rgba(0,0,0,0.65)":"#ffffff",fontSize:"8px",fontWeight:900,borderRadius:"999px",padding:"1px 4px",lineHeight:1.4,minWidth:14,textAlign:"center"}}>
                                {sg>0?`+${sg}`:sg===0?"E":sg}
                              </span>
                            )}
                          </button>

                          {/* Strokes +/- counter */}
                          <div style={{display:"flex",alignItems:"center",gap:3,background:"rgba(0,0,0,0.25)",borderRadius:10,padding:"2px 4px"}}>
                            <button
                              onClick={()=>updateScore(h,"strokes",Math.max(0,s-1))}
                              style={{width:30,height:30,borderRadius:8,background:"rgba(0,0,0,0.06)",color:"rgba(0,0,0,0.55)",fontWeight:900,fontSize:16,lineHeight:1,flexShrink:0}}
                              className="active:scale-90 transition-transform"
                            >−</button>
                            <div style={{flex:1,textAlign:"center",fontWeight:900,fontSize:16,color:s>0?"white":"rgba(0,0,0,0.12)"}}>
                              {s>0?s:"·"}
                            </div>
                            <button
                              onClick={()=>updateScore(h,"strokes",s+1)}
                              style={{width:30,height:30,borderRadius:8,background:"rgba(0,0,0,0.06)",color:"rgba(0,0,0,0.55)",fontWeight:900,fontSize:16,lineHeight:1,flexShrink:0}}
                              className="active:scale-90 transition-transform"
                            >+</button>
                          </div>

                          {/* Putts +/- counter */}
                          {(()=>{const p=Number(r.putts)||0;return(
                            <div style={{display:"flex",alignItems:"center",gap:2,background:"rgba(0,0,0,0.25)",borderRadius:10,padding:"2px 3px"}}>
                              <button onClick={()=>updateScore(h,"putts",Math.max(0,p-1))} style={{width:24,height:30,borderRadius:7,background:"rgba(0,0,0,0.06)",color:"rgba(0,0,0,0.45)",fontWeight:900,fontSize:14,lineHeight:1,flexShrink:0}} className="active:scale-90 transition-transform">−</button>
                              <div style={{flex:1,textAlign:"center",fontWeight:900,fontSize:13,color:p>0?"rgba(167,139,250,1)":"rgba(0,0,0,0.12)"}}>{p>0?p:"·"}</div>
                              <button onClick={()=>updateScore(h,"putts",p+1)} style={{width:24,height:30,borderRadius:7,background:"rgba(0,0,0,0.06)",color:"rgba(0,0,0,0.45)",fontWeight:900,fontSize:14,lineHeight:1,flexShrink:0}} className="active:scale-90 transition-transform">+</button>
                            </div>
                          );})()}

                          {/* FIR + GIR compact */}
                          <div style={{display:"flex",gap:3}}>
                            {r.par>=4?(
                              <button onClick={()=>updateScore(h,"fir",cycleState(r.fir))} style={{flex:1,height:36,borderRadius:9,fontWeight:900,fontSize:11,background:r.fir===true?"#15803d":r.fir===false?"rgba(239,68,68,0.35)":"rgba(0,0,0,0.3)",color:r.fir===true?"#ffffff":r.fir===false?"#fca5a5":"rgba(0,0,0,0.2)"}} className="active:scale-90 transition-transform">
                                {r.fir===true?"F✓":r.fir===false?"F✗":"F"}
                              </button>
                            ):(
                              <div style={{flex:1,height:36,borderRadius:9,background:"rgba(0,0,0,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"rgba(0,0,0,0.1)"}}>—</div>
                            )}
                            <button onClick={()=>updateScore(h,"gir",cycleState(r.gir))} style={{flex:1,height:36,borderRadius:9,fontWeight:900,fontSize:11,background:r.gir===true?"#15803d":r.gir===false?"rgba(239,68,68,0.35)":"rgba(0,0,0,0.3)",color:r.gir===true?"#ffffff":r.gir===false?"#fca5a5":"rgba(0,0,0,0.2)"}} className="active:scale-90 transition-transform">
                              {r.gir===true?"G✓":r.gir===false?"G✗":"G"}
                            </button>
                          </div>

                          {/* Penalty tap counter */}
                          <button
                            onClick={()=>updateScore(h,"penalties",((r.penalties||0)+1)%5)}
                            style={{height:36,borderRadius:9,fontWeight:900,fontSize:11,background:r.penalties>0?"rgba(239,68,68,0.25)":"rgba(0,0,0,0.25)",color:r.penalties>0?"#fca5a5":"rgba(0,0,0,0.12)"}}
                            className="active:scale-90 transition-transform"
                          >
                            {r.penalties>0?`+${r.penalties}`:"·"}
                          </button>
                        </div>

                        {/* Active hole: par selector + note */}
                        {isCurrent&&(
                          <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:6,padding:"6px 6px 2px"}} className="items-center">
                            <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(0,0,0,0.2)",borderRadius:10,padding:"4px 10px"}}>
                              <span style={{fontSize:10,color:"rgba(0,0,0,0.3)",fontWeight:700}}>Par</span>
                              {[3,4,5].map(p=>(
                                <button key={p} onClick={()=>updateScore(h,"par",p)} style={{width:26,height:26,borderRadius:7,fontWeight:900,fontSize:12,background:r.par===p?"#fcd34d":"rgba(0,0,0,0.06)",color:r.par===p?"#ffffff":"rgba(0,0,0,0.45)"}} className="active:scale-90 transition-transform">{p}</button>
                              ))}
                            </div>
                            <input
                              value={r.note||""}
                              onChange={e=>updateScore(h,"note",e.target.value)}
                              placeholder="Note for this hole..."
                              style={{height:34,borderRadius:10,background:"rgba(0,0,0,0.04)",border:"1px solid rgba(0,0,0,0.06)",padding:"0 12px",fontSize:11,color:"#111827",outline:"none"}}
                              className="placeholder-white/20"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          )}

          {/* ── STATS TAB ── */}
          {activeTab==="history"&&(
            <div className="tab-content space-y-4">
              <div className="grid grid-cols-4 gap-2">
                <StatCard label="Shots" value={shots.length}/>
                <StatCard label="Long" value={longest?`${longest.distance}y`:"-"}/>
                <StatCard label="Avg" value={avgDistance?`${avgDistance}y`:"-"}/>
                <StatCard label="Good" value={goodRate?`${goodRate}%`:"-"}/>
              </div>

              {/* Miss Tendency */}
              {missTendency.length>0&&(
                <Card className="p-4">
                  <div className="mb-1 font-black">🎯 Miss Tendency</div>
                  <p className="text-xs text-gray-400 mb-3">Based on all your tracked shots.</p>
                  <div className="space-y-2">
                    {missTendency.map(m=>(
                      <div key={m.name} className="rounded-2xl bg-gray-50 p-3">
                        <div className="flex items-center justify-between mb-1">
                          <p className="font-black text-sm">{m.name}</p>
                          <span className={"text-xs font-black px-2 py-0.5 rounded-full "+(m.goodPct>=70?"bg-[#15803d]/10 text-[#15803d]":"bg-amber-900/40 text-amber-700/80")}>{m.goodPct}% good</span>
                        </div>
                        <p className="text-xs text-gray-400">Misses <span className="text-amber-700/80 font-black">{m.dir}</span> {m.pct}% of the time · {m.total} shots tracked</p>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Club Averages (current round) */}
              {clubStats.length>0&&(
                <Card className="p-4">
                  <div className="mb-3 font-black">Club Averages (This Round)</div>
                  <div className="space-y-2">{clubStats.map(r=><div key={r.name} className="grid grid-cols-4 rounded-2xl bg-gray-50 p-3 text-sm"><div className="col-span-2 font-bold">{r.name}</div><div className="text-gray-600">Avg {r.avg}y</div><div className="text-right text-amber-700/80">Best {r.best}y</div></div>)}</div>
                </Card>
              )}

              {/* Club Gapping */}
              {clubGaps.clubs.length>=2&&(
                <Card className="p-4">
                  <div className="mb-1 font-black">📐 Club Gapping</div>
                  <p className="text-xs text-gray-400 mb-3">Personal averages · min {MIN_SHOTS} shots per club.</p>
                  {clubGaps.gaps.length===0?<p className="text-xs text-[#15803d] rounded-2xl bg-[#15803d]/06 p-3">Bag looks well-gapped. No significant gaps found.</p>:
                    <div className="space-y-2 mb-3">{clubGaps.gaps.map((g,i)=><div key={i} className="rounded-2xl bg-gray-50 p-3 border border-[#b45309]/20"><div className="flex items-center justify-between mb-1"><p className="text-sm font-black text-amber-700/80">{g.gap}y gap</p>{g.gap>30&&<span className="text-[10px] font-black bg-red-50 text-red-500 px-2 py-0.5 rounded-full">Significant</span>}</div><p className="text-xs text-gray-600">{g.high.name} ({g.high.avg}y) → {g.low.name} ({g.low.avg}y)</p><p className="text-xs text-gray-400 mt-1">Consider a club that carries ~{Math.round((g.high.avg+g.low.avg)/2)}y</p></div>)}</div>
                  }
                  <div className="space-y-1.5">{clubGaps.clubs.map(c=><div key={c.name} className="flex items-center gap-2"><p className="w-20 text-xs text-gray-600 flex-shrink-0">{c.name}</p><div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full bg-amber-400" style={{width:`${Math.min(100,(c.avg/280)*100)}%`}}/></div><p className="w-12 text-right text-xs font-black text-gray-700">{c.avg}y</p></div>)}</div>
                </Card>
              )}

              {/* Shot history */}
              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-black"><span className="text-amber-700">↺</span> Shot History</div>
                  <div className="flex gap-2">
                    {allTimeShots.length>0&&<button onClick={()=>exportShotsCSV(allTimeShots)} className="rounded-xl bg-emerald-500/15 px-3 py-2 text-xs font-bold text-[#15803d]">↓ CSV</button>}
                    <button onClick={clearRound} className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600">🗑 End Round</button>
                  </div>
                </div>
                {shots.length===0?<p className="rounded-2xl bg-gray-50 p-4 text-sm text-gray-400">No shots yet. Go to Track and save your first shot.</p>:
                  <div className="space-y-2">{shots.map(s=><div key={s.id} className="rounded-2xl bg-gray-50 p-3"><div className="flex items-center justify-between gap-3"><div><p className="font-black">{s.club} — {s.distance} yards</p><p className="text-xs text-gray-400">Hole {s.hole} · {s.shotShape} · {s.lie} · {s.result} · {fmtTime(s.finishedAt)} · ±{s.end?.accuracy||"?"}m</p>{s.note&&<p className="mt-1 text-xs text-gray-600">Note: {s.note}</p>}</div><button onClick={()=>openMaps(s.end)} className="rounded-xl bg-gray-100 p-2 text-amber-700/80">➤</button></div></div>)}</div>
                }
              </Card>

              {/* Round History */}
              {roundHistory.length>0&&(
                <Card className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="font-black">📅 Round History</div>
                    <button onClick={()=>{setRoundHistory([]);localStorage.removeItem("tracerbuddy_round_history");}} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-bold text-gray-400">Clear</button>
                  </div>
                  <div className="space-y-3">
                    {roundHistory.map(r=>{
                      const toParStr=r.strokes?(r.toPar===0?"E":r.toPar>0?`+${r.toPar}`:`${r.toPar}`):"-";
                      const toParColor=r.toPar<0?"text-[#15803d]":r.toPar>0?"text-red-500":"text-gray-900";
                      return (
                        <div key={r.id} className="rounded-2xl bg-gray-50 p-3">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div><p className="font-black text-sm">{r.courseName}</p><p className="text-xs text-gray-400">{fmtDate(r.date)}</p></div>
                            <div className="flex items-center gap-2">
                              <div className={`text-2xl font-black ${toParColor}`}>{toParStr}</div>
                              <button onClick={()=>setShareRound(r)} className="rounded-xl bg-amber-400/15 px-2 py-1.5 text-xs font-bold text-amber-700/80 active:scale-95">Share</button>
                            </div>
                          </div>
                          <div className="grid grid-cols-4 gap-1.5">
                            {[["HOLES",r.holesPlayed],["SCORE",r.strokes||"-"],["PUTTS",r.totalPutts||"-"],["LONG",r.longestDrive?`${r.longestDrive}y`:"-"]].map(([l,v])=><div key={l} className="rounded-xl bg-gray-50 p-2 text-center"><p className="text-[9px] text-gray-400">{l}</p><p className="text-sm font-black">{v}</p></div>)}
                          </div>
                          {(r.firT>0||r.girT>0)&&<div className="mt-1.5 flex gap-3"><p className="text-[10px] text-gray-400">FIR {r.firT?`${r.firH}/${r.firT}`:"-"}</p><p className="text-[10px] text-gray-400">GIR {r.girT?`${r.girH}/${r.girT}`:"-"}</p></div>}
                          {r.longestDrive>0&&<p className="mt-1 text-[10px] text-gray-400">Longest: {r.longestClub} · {r.longestDrive}y{r.elevationFt?` · ${r.elevationFt}ft elev`:""}</p>}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              {/* Stat Trends */}
              {roundHistory.length>=2&&(
                <Card className="p-4">
                  <div className="mb-1 font-black">📈 Trends</div>
                  <p className="text-xs text-gray-400 mb-4">Last {Math.min(10,roundHistory.length)} rounds.</p>
                  <div className="space-y-5">
                    {statTrends.toPar.length>=2&&<div><div className="flex items-center justify-between mb-1"><p className="text-xs font-black text-gray-600">Score vs Par</p><p className="text-xs text-gray-400">{statTrends.toPar[statTrends.toPar.length-1]>=0?"+":""}{statTrends.toPar[statTrends.toPar.length-1]} last round</p></div><Sparkline data={statTrends.toPar} color="#b45309" invert/><p className="text-[10px] text-gray-400 mt-1">Lower is better · chart inverted so up = improvement</p></div>}
                    {statTrends.longestDrive.length>=2&&<div><div className="flex items-center justify-between mb-1"><p className="text-xs font-black text-gray-600">Longest Drive</p><p className="text-xs text-gray-400">{statTrends.longestDrive[statTrends.longestDrive.length-1]}y last round</p></div><Sparkline data={statTrends.longestDrive} color="#6ee7b7"/><p className="text-[10px] text-gray-400 mt-1">Yards per round</p></div>}
                    {statTrends.goodPct.length>=2&&<div><div className="flex items-center justify-between mb-1"><p className="text-xs font-black text-gray-600">Shot Accuracy</p><p className="text-xs text-gray-400">{statTrends.goodPct[statTrends.goodPct.length-1]}% last round</p></div><Sparkline data={statTrends.goodPct} color="#a78bfa"/><p className="text-[10px] text-gray-400 mt-1">% good shots per round</p></div>}
                    {statTrends.puttsPerRound.length>=2&&<div><div className="flex items-center justify-between mb-1"><p className="text-xs font-black text-gray-600">Putts per Round</p><p className="text-xs text-gray-400">{statTrends.puttsPerRound[statTrends.puttsPerRound.length-1]} last round</p></div><Sparkline data={statTrends.puttsPerRound} color="#f472b6" invert/><p className="text-[10px] text-gray-400 mt-1">Lower is better</p></div>}
                  </div>
                </Card>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ── Splash Screen ── */}
      {splashVisible&&(
        <div style={{position:"fixed",inset:0,zIndex:100,background:"#f9fafb",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",opacity:splashFading?0:1,transition:"opacity 0.6s ease",pointerEvents:splashFading?"none":"all"}}>
          <img src="/tracerbuddy-icon.png" alt="TracerBuddy" style={{width:110,height:110,borderRadius:26,marginBottom:32,animation:"splashPulse 2.5s ease-in-out infinite"}}/>
          <div style={{fontSize:36,fontWeight:900,letterSpacing:"-0.5px",marginBottom:10}}>
            <span style={{color:"#15803d"}}>Tracer</span><span style={{color:"#b45309"}}>Buddy</span>
          </div>
          <p style={{fontSize:13,color:"rgba(0,0,0,0.2)",margin:0,letterSpacing:"0.04em",textTransform:"uppercase"}}>The smarter way to track every shot.</p>
          <div style={{marginTop:56,display:"flex",gap:7}}>
            {[0,1,2].map(i=><div key={i} style={{width:5,height:5,borderRadius:"50%",background:"#b45309",animation:`splashDot 1.3s ease-in-out ${i*0.2}s infinite`}}/>)}
          </div>
        </div>
      )}

      {/* ── Share Modal ── */}
      {shareRound&&(()=>{
        const r=shareRound;
        const toParStr=r.strokes?(r.toPar===0?"E":r.toPar>0?`+${r.toPar}`:`${r.toPar}`):"-";
        const toParColor=r.toPar<0?"#15803d":r.toPar>0?"#dc2626":"#111827";
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:50,display:"flex",alignItems:"center",justifyContent:"center",padding:"24px"}}>
            <div style={{width:"100%",maxWidth:"360px"}}>
              <div style={{background:"#f9fafb",border:"1px solid rgba(0,0,0,0.08)",borderRadius:"28px",overflow:"hidden"}}>
                <div style={{background:"linear-gradient(135deg,rgba(21,128,61,0.15),rgba(251,191,36,0.2))",padding:"24px 24px 20px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"16px"}}>
                    <div><div style={{fontSize:"22px",fontWeight:900,letterSpacing:"-0.5px"}}><span style={{color:"#15803d"}}>Tracer</span><span style={{color:"#b45309"}}>Buddy</span></div><p style={{fontSize:"11px",color:"rgba(0,0,0,0.4)",margin:"2px 0 0"}}>Round Summary</p></div>
                    <div style={{fontSize:"36px"}}>⛳</div>
                  </div>
                  <p style={{fontSize:"17px",fontWeight:900,color:"#111827",margin:"0 0 2px"}}>{r.courseName}</p>
                  <p style={{fontSize:"12px",color:"rgba(0,0,0,0.4)",margin:0}}>{new Date(r.date).toLocaleDateString([],{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</p>
                </div>
                <div style={{padding:"20px 24px",borderBottom:"1px solid rgba(0,0,0,0.06)"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div><p style={{fontSize:"11px",fontWeight:900,letterSpacing:"0.2em",color:"rgba(0,0,0,0.3)",textTransform:"uppercase",margin:"0 0 4px"}}>Score</p><p style={{fontSize:"52px",fontWeight:900,color:"#111827",lineHeight:1,margin:0}}>{r.strokes||"-"}</p></div>
                    <div style={{textAlign:"right"}}><p style={{fontSize:"11px",fontWeight:900,letterSpacing:"0.2em",color:"rgba(0,0,0,0.3)",textTransform:"uppercase",margin:"0 0 4px"}}>To Par</p><p style={{fontSize:"52px",fontWeight:900,color:toParColor,lineHeight:1,margin:0}}>{toParStr}</p></div>
                  </div>
                </div>
                <div style={{padding:"16px 24px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}>
                  {[["Holes Played",r.holesPlayed],["Shots Tracked",r.shotsTracked],["Longest Drive",r.longestDrive?`${r.longestDrive}y`:"-"],["Best Club",r.longestClub||"-"],["Total Putts",r.totalPutts||"-"],["FIR / GIR",r.firT?`${r.firH}/${r.firT} · ${r.girH}/${r.girT}`:"-"]].map(([l,v])=>(<div key={l} style={{background:"rgba(0,0,0,0.05)",borderRadius:"14px",padding:"12px"}}><p style={{fontSize:"10px",color:"rgba(0,0,0,0.35)",textTransform:"uppercase",letterSpacing:"0.12em",margin:"0 0 3px"}}>{l}</p><p style={{fontSize:"16px",fontWeight:900,color:"#111827",margin:0}}>{v}</p></div>))}
                </div>
                <div style={{padding:"0 24px 20px",textAlign:"center"}}><p style={{fontSize:"11px",color:"rgba(0,0,0,0.15)",margin:0}}>Tracked with TracerBuddy</p></div>
              </div>
              <p style={{fontSize:"12px",color:"rgba(0,0,0,0.35)",textAlign:"center",margin:"14px 0 10px"}}>Screenshot the card above to share</p>
              <button onClick={()=>setShareRound(null)} style={{width:"100%",height:"52px",background:"rgba(0,0,0,0.06)",border:"none",borderRadius:"18px",color:"#111827",fontSize:"15px",fontWeight:900,cursor:"pointer"}}>Close</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
