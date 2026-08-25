#!/usr/bin/env python3
# PV-Überschuss-Steuerung für eine NVIDIA RTX 3070 unter Linux.
# Miner: lolMiner -> NiceHash (Autolykos2), Auszahlung in Bitcoin.
# Regelt die GPU nach PV-Überschuss (Shelly Pro 3EM) und fährt den PC
# abends bei längerem Unterschuss herunter. Aufwecken per BIOS-RTC-Timer.
import time
import signal
import subprocess
import requests

# ===================== KONFIGURATION =====================
SHELLY_IP  = "192.168.178.27"
MINER_PATH = "/home/heizung/1.98a/lolMiner"
ALGO       = "AUTOLYKOS2"
POOL       = "autolykos.auto.nicehash.com:9200"
USER_ADDR  = "NHbG3iSSdb23qV4pWDsJpSKzuCm2tySTeGcn"   # NiceHash-BTC-Adresse
RIG_NAME   = "rig1"
TLS        = "0"
GPU_INDEX  = 0

PUFFER   = 60     # W Reserve gegen Netzbezug
PL_MIN   = 100    # W kleinstes Power-Limit
PL_MAX   = 200    # W groesstes Power-Limit
ON_W     = 160    # einschalten ab so viel verfuegbarem Ueberschuss (W)
OFF_W    = 110    # ausschalten darunter (Hysterese)
INTERVAL = 20     # Sekunden

# --- Auto-Shutdown bei laengerem Unterschuss ---
ENABLE_SHUTDOWN        = True    # RTC-Aufwecken ist getestet -> Auto-Shutdown aktiv
IDLE_SHUTDOWN_MIN      = 30      # min ohne nutzbaren Ueberschuss -> herunterfahren
SHUTDOWN_NOT_BEFORE_HR = 17      # erst ab dieser Uhrzeit (verhindert Mittags-Aus)
# =========================================================

miner = None
cur_pl = 0
running = True
idle_since = None

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

def run(cmd):
    subprocess.run(cmd, check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def surplus_w():
    r = requests.get("http://" + SHELLY_IP + "/rpc/EM.GetStatus",
                     params={"id": 0}, timeout=4)
    return -r.json()["total_act_power"]

def set_pl(w):
    run(["nvidia-smi", "-i", str(GPU_INDEX), "-pl", str(w)])

def start_miner():
    global miner
    if miner is None:
        cmd = [MINER_PATH, "--algo", ALGO, "--pool", POOL,
               "--user", USER_ADDR + "." + RIG_NAME, "--tls", TLS,
               "--apihost", "127.0.0.1", "--apiport", "4444"]
        miner = subprocess.Popen(cmd)
        log("Miner gestartet.")

def stop_miner():
    global miner
    if miner is not None:
        miner.terminate()
        try:
            miner.wait(timeout=15)
        except subprocess.TimeoutExpired:
            miner.kill()
        miner = None
        log("Miner gestoppt.")

def on_signal(*_):
    global running
    running = False

signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)

run(["nvidia-smi", "-pm", "1"])
log("PV-GPU-Steuerung gestartet (NiceHash/Autolykos).")

while running:
    try:
        s = surplus_w()
        available = s + cur_pl

        if miner is None:
            if available >= ON_W:
                pl = max(PL_MIN, min(PL_MAX, int(available - PUFFER)))
                set_pl(pl); cur_pl = pl; start_miner()
                log("Ueberschuss %.0f W -> EIN @ %d W" % (available, pl))
        else:
            if available < OFF_W:
                stop_miner(); cur_pl = 0
                log("Ueberschuss %.0f W -> AUS" % available)
            else:
                pl = max(PL_MIN, min(PL_MAX, int(available - PUFFER)))
                if abs(pl - cur_pl) >= 10:
                    set_pl(pl); cur_pl = pl
                    log("Ueberschuss %.0f W -> %d W" % (available, pl))

        # --- Auto-Shutdown-Logik ---
        low = (miner is None) and (available < ON_W)
        if low:
            if idle_since is None:
                idle_since = time.time()
            else:
                idle_min = (time.time() - idle_since) / 60.0
                hour = time.localtime().tm_hour
                if idle_min >= IDLE_SHUTDOWN_MIN and hour >= SHUTDOWN_NOT_BEFORE_HR:
                    log("Kein Ueberschuss seit %.0f min (%d Uhr) -> Shutdown-Bedingung erfuellt." % (idle_min, hour))
                    if ENABLE_SHUTDOWN:
                        stop_miner()
                        subprocess.run(["shutdown", "-h", "now"])
                        break
        else:
            idle_since = None

    except Exception as e:
        log("Fehler:", e)

    for _ in range(INTERVAL):
        if not running:
            break
        time.sleep(1)

stop_miner()
log("Beendet.")
