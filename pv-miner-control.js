// ============================================================
//  PV-Überschuss-Steuerung + Dashboard (7-Tage-Verlauf)
//  Antminer S19K Pro – läuft direkt auf dem Shelly Pro 3EM.
//  Miner-Firmware: Braiins OS+ (REST-API auf Port 80, /api/v1)
// ------------------------------------------------------------
//  DASHBOARD nach dem Start erreichbar unter:
//    http://<shelly-ip>/script/<script-id>/ui
//  (script-id = Nummer in der Shelly-UI unter "Scripts")
//  WICHTIG: Script-Option "Run on startup" aktivieren, damit
//  es nach einem Neustart automatisch weiterläuft.
// ------------------------------------------------------------
//  Speichergrenzen des Shelly (bewusst eingehalten):
//   - 7-Tage-Verlauf = stündliche Mittelwerte (168 Punkte)
//   - Persistenz in KVS, je Block <=253 Zeichen, 7 Schlüssel
//  KEINE echten Zugangsdaten/IP committen – nur lokal eintragen!
// ============================================================

let CONFIG = {
  // --- Miner (Braiins OS+) ---
  minerIp:   "192.168.0.0",   // <-- lokale IP des Miners eintragen
  minerUser: "root",          // Braiins-OS+-Benutzername
  minerPass: "CHANGE_ME",     // Braiins-OS+-Passwort (lokal eintragen)

  // --- Regelung ---
  puffer:       100,   // W Sicherheitspuffer, damit nichts ins Netz fließt
  intervalSec:  30,    // Prüfintervall in Sekunden

  // S19K Pro: stabil ca. 900–2760 W -> hier 900–1900 W genutzt:
  powerLevels:  [900, 1100, 1300, 1500, 1700, 1900],
  onThreshold:  1050,  // EIN ab diesem Überschuss (W)
  offThreshold: 850,   // AUS unter diesem Überschuss (W)
};

// ----- Laufzeit-Status -----
let token       = null;
let minerOn     = false;
let currentWatt = 0;
let lastSurplus = 0;

// ----- 7-Tage-Verlauf (stündlich, Werte in 10-W-Schritten; -1 = keine Daten) -----
let MAXP    = 168;         // 7 Tage * 24 h
let hS      = [];          // Überschuss-Verlauf
let hW      = [];          // Miner-Leistung-Verlauf
let lastHour = null;       // Stundenindex des neuesten Punkts
let curHour  = null;       // aktuell laufende Stunde
let sumS = 0, sumW = 0, cnt = 0;

// ============================================================
//  Miner-Kommunikation (Braiins OS+ REST-API)
// ============================================================
function minerRequest(method, path, bodyObj, cb) {
  let params = {
    method: method,
    url: "http://" + CONFIG.minerIp + path,
    timeout: 8,
    headers: { "Content-Type": "application/json" },
  };
  // Falls deine BOS+-Version "Bearer " erwartet: "Bearer " + token
  if (token !== null) { params.headers.Authorization = token; }
  if (bodyObj !== null) { params.body = JSON.stringify(bodyObj); }
  Shelly.call("HTTP.Request", params, function (res, ec, em) {
    if (ec !== 0 || res === null) { print("HTTP-Fehler:", ec, em); cb(false, null); return; }
    cb(res.code >= 200 && res.code < 300, res);
  });
}
function login(cb) {
  token = null;
  minerRequest("POST", "/api/v1/auth/login",
    { username: CONFIG.minerUser, password: CONFIG.minerPass },
    function (ok, res) {
      if (ok && res.body) {
        try { token = JSON.parse(res.body).token; print("Login ok."); cb(true); return; }
        catch (e) { print("Login-Parsefehler:", e); }
      }
      print("Login fehlgeschlagen."); cb(false);
    });
}
function withAuth(action) {
  if (token === null) { login(function (ok) { if (ok) { action(); } }); }
  else { action(); }
}
function setPowerTarget(watt) {
  withAuth(function () {
    minerRequest("PUT", "/api/v1/performance/power-target", { watt: watt }, function (ok, res) {
      if (!ok && res !== null && res.code === 401) {
        login(function (li) { if (li) { setPowerTarget(watt); } }); return;
      }
      if (ok) { currentWatt = watt; print("Power-Target:", watt, "W"); }
    });
  });
}
function pauseMiner() {
  withAuth(function () {
    minerRequest("PUT", "/api/v1/actions/pause", null, function (ok) {
      if (ok) { minerOn = false; currentWatt = 0; print("Miner pausiert."); }
    });
  });
}
function resumeMiner(thenWatt) {
  withAuth(function () {
    minerRequest("PUT", "/api/v1/actions/resume", null, function (ok) {
      if (ok) { minerOn = true; print("Miner gestartet."); setPowerTarget(thenWatt); }
    });
  });
}

// ============================================================
//  Regel-Hilfen
// ============================================================
function chooseLevel(available) {
  let chosen = 0;
  for (let i = 0; i < CONFIG.powerLevels.length; i++) {
    if (CONFIG.powerLevels[i] <= available - CONFIG.puffer) { chosen = CONFIG.powerLevels[i]; }
  }
  return chosen;
}
function readSurplus() {
  let em = Shelly.getComponentStatus("em:0");
  if (em === null || em.total_act_power === undefined) { return null; }
  return -em.total_act_power;  // negativ = Einspeisung -> umdrehen
}

// ============================================================
//  7-Tage-Verlauf: Aggregation + Persistenz (KVS)
// ============================================================
function pushPoint(s, w) {
  hS.push(s); hW.push(w);
  if (hS.length > MAXP) {            // ältesten Punkt verwerfen (ohne shift)
    let nS = [], nW = [];
    for (let i = hS.length - MAXP; i < hS.length; i++) { nS.push(hS[i]); nW.push(hW[i]); }
    hS = nS; hW = nW;
  }
}
function finalizeHour() {
  let s = cnt > 0 ? (((sumS / cnt) + 5) / 10) | 0 : -1;   // 10-W-Schritte
  let w = cnt > 0 ? (((sumW / cnt) + 5) / 10) | 0 : 0;
  pushPoint(s, w);
  lastHour = curHour;
}
function persist() {
  Shelly.call("KVS.Set", { key: "pvmeta", value: { lh: lastHour, n: hS.length } }, null);
  let CH = 56;
  for (let c = 0; c < 3; c++) {
    let s = [], w = [];
    for (let i = c * CH; i < c * CH + CH && i < hS.length; i++) { s.push(hS[i]); w.push(hW[i]); }
    Shelly.call("KVS.Set", { key: "pvs" + c, value: s }, null);
    Shelly.call("KVS.Set", { key: "pvw" + c, value: w }, null);
  }
}
let loadParts = {}, loadCount = 0;
let LOAD_KEYS = ["pvmeta", "pvs0", "pvs1", "pvs2", "pvw0", "pvw1", "pvw2"];
function loadOne(k) {
  Shelly.call("KVS.Get", { key: k }, function (res, ec) {
    if (ec === 0 && res !== null && res.value !== undefined) { loadParts[k] = res.value; }
    loadCount++;
    if (loadCount === LOAD_KEYS.length) { assembleHistory(); }
  });
}
function loadHistory() { for (let i = 0; i < LOAD_KEYS.length; i++) { loadOne(LOAD_KEYS[i]); } }
function assembleHistory() {
  try {
    if (!loadParts.pvmeta) { print("Keine gespeicherte Historie."); return; }
    lastHour = loadParts.pvmeta.lh;
    let s = [], w = [];
    for (let c = 0; c < 3; c++) {
      let sc = loadParts["pvs" + c], wc = loadParts["pvw" + c];
      if (sc) { for (let i = 0; i < sc.length; i++) { s.push(sc[i]); } }
      if (wc) { for (let i = 0; i < wc.length; i++) { w.push(wc[i]); } }
    }
    if (s.length > 0) { hS = s; hW = w; print("Historie geladen:", s.length, "Punkte"); }
  } catch (e) { print("Historie-Ladefehler:", e); }
}
function aggregate(now, surplus) {
  let h = (now - (now % 3600)) / 3600;
  if (curHour === null) { curHour = h; }
  if (h !== curHour) {
    finalizeHour();
    let gap = h - curHour - 1;
    for (let g = 0; g < gap; g++) { curHour += 1; pushPoint(-1, 0); lastHour = curHour; }
    curHour = h; sumS = 0; sumW = 0; cnt = 0;
    persist();                    // einmal pro Stunde sichern
  }
  sumS += surplus; sumW += currentWatt; cnt += 1;
}

// ============================================================
//  Hauptlogik (periodisch)
// ============================================================
function tick() {
  let surplus = readSurplus();
  if (surplus === null) { print("Keine EM-Daten."); return; }
  lastSurplus = surplus;
  let available = surplus + currentWatt;   // Miner-Eigenverbrauch zurückrechnen

  if (!minerOn) {
    if (available >= CONFIG.onThreshold) {
      let lvl = chooseLevel(available);
      if (lvl >= CONFIG.powerLevels[0]) { print("Ueberschuss", available, "-> EIN @", lvl); resumeMiner(lvl); }
    }
  } else {
    if (available < CONFIG.offThreshold) { print("Ueberschuss", available, "-> AUS"); pauseMiner(); }
    else {
      let lvl = chooseLevel(available);
      if (lvl < CONFIG.powerLevels[0]) { lvl = CONFIG.powerLevels[0]; }
      if (lvl !== currentWatt) { print("Ueberschuss", available, "-> Stufe", lvl); setPowerTarget(lvl); }
    }
  }

  // 7-Tage-Verlauf nur fortschreiben, wenn die Uhrzeit synchron ist
  let sys = Shelly.getComponentStatus("sys");
  if (sys !== null && sys.unixtime) { aggregate(sys.unixtime, surplus); }
}

// ============================================================
//  Dashboard-Endpunkte (vom Shelly selbst ausgeliefert)
// ============================================================
function handleData(request, response) {
  let surplus = readSurplus(); if (surplus === null) { surplus = lastSurplus; }
  response.code = 200;
  response.headers = [["Content-Type", "application/json"], ["Access-Control-Allow-Origin", "*"]];
  response.body = JSON.stringify({ on: minerOn, watt: currentWatt, surplus: surplus, available: surplus + currentWatt });
  response.send();
}
function handleHistory(request, response) {
  response.code = 200;
  response.headers = [["Content-Type", "application/json"], ["Access-Control-Allow-Origin", "*"]];
  // Werte in 10-W-Schritten; im Browser *10 rechnen. step = Sekunden je Punkt.
  response.body = JSON.stringify({ lh: lastHour, step: 3600, s: hS, w: hW });
  response.send();
}
function handleUi(request, response) {
  let h =
"<!DOCTYPE html><html lang='de'><head><meta charset='utf-8'>" +
"<meta name='viewport' content='width=device-width,initial-scale=1'><title>PV-Miner</title><style>" +
"body{font-family:system-ui,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}" +
".wrap{max-width:520px;margin:0 auto}h1{font-size:19px;margin:0 0 14px}" +
".badge{display:inline-block;padding:5px 13px;border-radius:999px;font-weight:700;font-size:13px}" +
".on{background:#16a34a}.off{background:#475569}" +
".grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:14px}" +
".card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px}" +
".lbl{font-size:11px;color:#94a3b8}.val{font-size:21px;font-weight:700;margin-top:3px}" +
".chart{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:12px;margin-top:14px}" +
".foot{margin-top:12px;font-size:11px;color:#64748b}" +
"</style></head><body><div class='wrap'><h1>PV-Überschuss-Mining</h1>" +
"<div id='st' class='badge off'>…</div><div class='grid'>" +
"<div class='card'><div class='lbl'>Power-Target</div><div class='val'><span id='w'>–</span> W</div></div>" +
"<div class='card'><div class='lbl'>Überschuss</div><div class='val'><span id='su'>–</span> W</div></div>" +
"<div class='card'><div class='lbl'>Verfügbar</div><div class='val'><span id='av'>–</span> W</div></div>" +
"</div><div class='chart'><div class='lbl' style='margin-bottom:6px'>7 Tage – Überschuss (gelb) &amp; Miner (grün)</div>" +
"<div id='cv'></div></div>" +
"<div class='foot'>Aktualisiert: <span id='ts'>–</span> · Live 5 s · Verlauf 60 s</div></div><script>" +
"const $=i=>document.getElementById(i);" +
"async function live(){try{const d=await(await fetch('data')).json();" +
"const b=$('st');b.textContent=d.on?'MINER LÄUFT':'MINER AUS';b.className='badge '+(d.on?'on':'off');" +
"$('w').textContent=d.on?d.watt:0;$('su').textContent=Math.round(d.surplus);$('av').textContent=Math.round(d.available);" +
"$('ts').textContent=new Date().toLocaleTimeString();}catch(e){$('ts').textContent='Fehler';}}" +
"function chart(d){const W=480,H=160,P=26,n=d.s.length;if(!n){$('cv').innerHTML='<div class=lbl>noch keine Daten</div>';return;}" +
"const sw=d.s.map(v=>v<0?-1:v*10),mw=d.w.map(v=>v<0?-1:v*10);" +
"let mx=2000;for(const v of sw)if(v>mx)mx=v;for(const v of mw)if(v>mx)mx=v;" +
"const X=i=>P+i*(W-2*P)/(n-1||1),Y=v=>H-P-(v/mx)*(H-2*P);" +
"function path(a){let s='',pen=0;for(let i=0;i<n;i++){if(a[i]<0){pen=0;continue;}s+=(pen?' L':' M')+X(i).toFixed(1)+','+Y(a[i]).toFixed(1);pen=1;}return s;}" +
"let g='',lab='';const t0=(d.lh-(n-1));for(let i=0;i<n;i++){const hr=(t0+i);if(hr%24===0){const x=X(i).toFixed(1);g+='<line x1='+x+' y1='+P+' x2='+x+' y2='+(H-P)+' stroke=#334155 stroke-width=1/>';" +
"const dt=new Date(hr*3600*1000);lab+='<text x='+x+' y='+(H-8)+' fill=#64748b font-size=9 text-anchor=middle>'+dt.getDate()+'.'+(dt.getMonth()+1)+'</text>';}}" +
"const svg='<svg viewBox=\"0 0 '+W+' '+H+'\" width=100% style=\"max-width:480px\">'+g+" +
"'<line x1='+P+' y1='+(H-P)+' x2='+(W-P)+' y2='+(H-P)+' stroke=#475569 stroke-width=1/>'+" +
"'<path d=\"'+path(sw)+'\" fill=none stroke=#eab308 stroke-width=2/>'+" +
"'<path d=\"'+path(mw)+'\" fill=none stroke=#22c55e stroke-width=2/>'+" +
"'<text x='+P+' y='+(P-8)+' fill=#94a3b8 font-size=9>'+mx+' W</text>'+lab+'</svg>';$('cv').innerHTML=svg;}" +
"async function hist(){try{chart(await(await fetch('history')).json());}catch(e){}}" +
"live();hist();setInterval(live,5000);setInterval(hist,60000);" +
"</script></body></html>";
  response.code = 200;
  response.headers = [["Content-Type", "text/html; charset=utf-8"]];
  response.body = h;
  response.send();
}

// ============================================================
//  Start
// ============================================================
print("PV-Miner-Steuerung + 7-Tage-Dashboard gestartet (S19K Pro).");
loadHistory();
HTTPServer.registerEndpoint("ui", handleUi);
HTTPServer.registerEndpoint("data", handleData);
HTTPServer.registerEndpoint("history", handleHistory);
Timer.set(CONFIG.intervalSec * 1000, true, tick);
