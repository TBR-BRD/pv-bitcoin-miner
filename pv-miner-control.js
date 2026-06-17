// ============================================================
//  PV-Überschuss-Steuerung für Bitcoin-Miner (Antminer S19K Pro)
//  Läuft direkt auf dem Shelly Pro 3EM (Menü: Scripts).
//  Miner-Firmware: Braiins OS+ (REST-API auf Port 80, /api/v1)
// ------------------------------------------------------------
//  WICHTIG – KEINE echten Zugangsdaten/IP committen!
//  Trage minerIp und minerPass nur lokal auf dem Shelly ein.
//  (Siehe .gitignore und README, Abschnitt "Sicherheit".)
// ============================================================

let CONFIG = {
  // --- Miner (Braiins OS+) ---
  minerIp:   "192.168.0.0",   // <-- lokale IP des Miners eintragen
  minerUser: "root",          // Braiins-OS+-Benutzername
  minerPass: "CHANGE_ME",     // Braiins-OS+-Passwort (lokal eintragen)

  // --- Regelung ---
  puffer:       100,   // W Sicherheitspuffer, damit nichts ins Netz fließt
  intervalSec:  30,    // Prüfintervall in Sekunden

  // S19K Pro: stabil ca. 900–2760 W. Hier auf den nutzbaren
  // Überschuss (max. 2000 W) begrenzt -> Stufen 900–1900 W:
  powerLevels:  [900, 1100, 1300, 1500, 1700, 1900],

  // Hysterese gegen ständiges Schalten an der Einschaltgrenze:
  onThreshold:  1050,  // erst EIN, wenn so viel Überschuss anliegt (W)
  offThreshold: 850,   // AUS, wenn Überschuss darunter fällt (W)
};

// ----- Laufzeit-Status -----
let token       = null;   // Auth-Token der Braiins-REST-API
let minerOn     = false;  // läuft der Miner aktuell?
let currentWatt = 0;      // zuletzt gesetztes Power-Target (W)

// ----- HTTP-Request an den Miner -----
function minerRequest(method, path, bodyObj, cb) {
  let params = {
    method: method,
    url: "http://" + CONFIG.minerIp + path,
    timeout: 8,
    headers: { "Content-Type": "application/json" },
  };
  // Token als Authorization-Header. Falls deine BOS+-Version
  // "Bearer " erwartet, hier auf "Bearer " + token ändern:
  if (token !== null) { params.headers.Authorization = token; }
  if (bodyObj !== null) { params.body = JSON.stringify(bodyObj); }

  Shelly.call("HTTP.Request", params, function (res, errCode, errMsg) {
    if (errCode !== 0 || res === null) {
      print("HTTP-Fehler:", errCode, errMsg);
      cb(false, null);
      return;
    }
    cb(res.code >= 200 && res.code < 300, res);
  });
}

// ----- Login: holt einen Token -----
function login(cb) {
  token = null;
  minerRequest("POST", "/api/v1/auth/login",
    { username: CONFIG.minerUser, password: CONFIG.minerPass },
    function (ok, res) {
      if (ok && res.body) {
        try {
          let data = JSON.parse(res.body);
          token = data.token;
          print("Login erfolgreich.");
          cb(true);
          return;
        } catch (e) { print("Login-Parsefehler:", e); }
      }
      print("Login fehlgeschlagen.");
      cb(false);
    });
}

// ----- Aktion mit gültigem Token ausführen -----
function withAuth(action) {
  if (token === null) {
    login(function (ok) { if (ok) { action(); } });
  } else {
    action();
  }
}

// ----- Power-Target setzen (W) -----
function setPowerTarget(watt) {
  withAuth(function () {
    minerRequest("PUT", "/api/v1/performance/power-target", { watt: watt },
      function (ok, res) {
        // Token abgelaufen -> neu einloggen und einmal wiederholen
        if (!ok && res !== null && res.code === 401) {
          login(function (loggedIn) {
            if (loggedIn) { setPowerTarget(watt); }
          });
          return;
        }
        if (ok) {
          currentWatt = watt;
          print("Power-Target gesetzt:", watt, "W");
        }
      });
  });
}

// ----- Miner pausieren / fortsetzen -----
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
      if (ok) {
        minerOn = true;
        print("Miner gestartet.");
        setPowerTarget(thenWatt);
      }
    });
  });
}

// ----- passende Leistungsstufe wählen -----
function chooseLevel(available) {
  let chosen = 0;
  for (let i = 0; i < CONFIG.powerLevels.length; i++) {
    if (CONFIG.powerLevels[i] <= available - CONFIG.puffer) {
      chosen = CONFIG.powerLevels[i];
    }
  }
  return chosen;  // 0 = kein Level passt (zu wenig Überschuss)
}

// ----- Hauptlogik (periodisch) -----
function tick() {
  let em = Shelly.getComponentStatus("em:0");
  if (em === null || em.total_act_power === undefined) {
    print("Keine EM-Daten verfügbar.");
    return;
  }

  // total_act_power: negativ = Einspeisung (Überschuss)
  let grid    = em.total_act_power;
  let surplus = -grid;                    // positiv = Überschuss
  // Eigenverbrauch des Miners zurückrechnen -> verhindert Pendeln:
  let available = surplus + currentWatt;

  if (!minerOn) {
    // Miner aus -> nur einschalten, wenn genug Überschuss da ist
    if (available >= CONFIG.onThreshold) {
      let lvl = chooseLevel(available);
      if (lvl >= CONFIG.powerLevels[0]) {
        print("Ueberschuss", available, "W -> Miner EIN @", lvl, "W");
        resumeMiner(lvl);
      }
    }
  } else {
    // Miner läuft -> ausschalten oder Stufe anpassen
    if (available < CONFIG.offThreshold) {
      print("Ueberschuss", available, "W -> Miner AUS");
      pauseMiner();
    } else {
      let lvl = chooseLevel(available);
      if (lvl < CONFIG.powerLevels[0]) { lvl = CONFIG.powerLevels[0]; }
      if (lvl !== currentWatt) {
        print("Ueberschuss", available, "W -> Stufe", lvl, "W");
        setPowerTarget(lvl);
      }
    }
  }
}

// ----- Start -----
print("PV-Miner-Steuerung gestartet (S19K Pro).");
Timer.set(CONFIG.intervalSec * 1000, true, tick);
