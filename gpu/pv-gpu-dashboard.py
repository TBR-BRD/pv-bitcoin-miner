#!/usr/bin/env python3
# Terminal-Dashboard fuer die PV-GPU-Steuerung. Per SSH aufrufen:
#   ssh <user>@<tailscale-ip>
#   python3 pv-gpu-dashboard.py
# Beenden mit q oder Strg+C.
import curses
import json
import subprocess
import time
import urllib.request

SHELLY_IP    = "192.168.178.27"
PLUG_IP      = "192.168.178.180"   # Shelly Plug S vor dem PC (Gesamtaufnahme des Rechners)
LOLMINER_API = "http://127.0.0.1:4444"
SERVICE      = "pv-gpu.service"
REFRESH_SEC  = 5


def get_surplus():
    try:
        with urllib.request.urlopen(
            "http://" + SHELLY_IP + "/rpc/EM.GetStatus?id=0", timeout=4
        ) as r:
            data = json.load(r)
        return -data["total_act_power"]
    except Exception:
        return None


def get_gpu():
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=temperature.gpu,power.draw,power.limit,utilization.gpu,memory.used",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=4, check=True,
        ).stdout.strip()
        temp, pdraw, plimit, util, mem = [x.strip() for x in out.split(",")]
        return {
            "temp": float(temp), "power": float(pdraw), "limit": float(plimit),
            "util": float(util), "mem": float(mem),
        }
    except Exception:
        return None


def get_miner_stats():
    try:
        with urllib.request.urlopen(LOLMINER_API, timeout=3) as r:
            data = json.load(r)
        algo = (data.get("Algorithms") or [{}])[0]
        return {
            "hashrate": algo.get("Total_Performance", 0),
            "unit": algo.get("Performance_Unit", "H/s"),
            "accepted": algo.get("Total_Accepted", 0),
            "rejected": algo.get("Total_Rejected", 0),
            "uptime": data.get("Session", {}).get("Uptime", 0),
        }
    except Exception:
        return None


def get_plug():
    try:
        with urllib.request.urlopen(
            "http://" + PLUG_IP + "/status", timeout=4
        ) as r:
            data = json.load(r)
        meter = (data.get("meters") or [{}])[0]
        relay = (data.get("relays") or [{}])[0]
        return {
            "power": meter.get("power", 0.0),
            "total_kwh": meter.get("total", 0) / 60000.0,
            "on": relay.get("ison", False),
        }
    except Exception:
        return None


def get_service_active():
    try:
        return subprocess.run(
            ["systemctl", "is-active", SERVICE],
            capture_output=True, text=True, timeout=3,
        ).stdout.strip()
    except Exception:
        return "unbekannt"


def fmt_uptime(sec):
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return "%02d:%02d:%02d" % (h, m, s)


def draw(stdscr):
    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(REFRESH_SEC * 1000)

    while True:
        surplus = get_surplus()
        gpu = get_gpu()
        miner = get_miner_stats()
        plug = get_plug()
        service = get_service_active()

        stdscr.erase()
        row = 0

        def line(text=""):
            nonlocal row
            try:
                stdscr.addstr(row, 0, text)
            except curses.error:
                pass
            row += 1

        line("PV-GPU-Mining Dashboard".ljust(40) + time.strftime("%d.%m.%Y %H:%M:%S"))
        line("=" * 60)
        line()
        line("Dienst (%s): %s" % (SERVICE, service))
        line("PV-Ueberschuss:      %s"
             % (("%.0f W" % surplus) if surplus is not None else "n/a (Shelly nicht erreichbar)"))
        line()

        if gpu:
            line("GPU:")
            line("  Temperatur:        %.0f degC" % gpu["temp"])
            line("  Leistung:          %.0f / %.0f W (Limit)" % (gpu["power"], gpu["limit"]))
            line("  Auslastung:        %.0f %%" % gpu["util"])
            line("  VRAM belegt:       %.0f MiB" % gpu["mem"])
        else:
            line("GPU: nicht auslesbar (nvidia-smi fehlgeschlagen)")
        line()

        if miner:
            line("Miner (lolMiner-API):")
            line("  Hashrate:          %.1f %s" % (miner["hashrate"], miner["unit"]))
            line("  Accepted/Rejected: %s / %s" % (miner["accepted"], miner["rejected"]))
            line("  Laufzeit:          %s" % fmt_uptime(miner["uptime"]))
        else:
            line("Miner: aktuell nicht aktiv oder API nicht erreichbar")
        line()

        if plug:
            line("Steckdose PC (Shelly Plug S):")
            line("  Zustand:           %s" % ("EIN" if plug["on"] else "AUS"))
            line("  Leistungsaufnahme: %.1f W" % plug["power"])
            line("  Gesamt (seit Reset): %.2f kWh" % plug["total_kwh"])
        else:
            line("Steckdose PC: nicht erreichbar")

        line()
        line("-" * 60)
        line("q = beenden, Aktualisierung alle %ds" % REFRESH_SEC)

        stdscr.refresh()

        key = stdscr.getch()
        if key in (ord("q"), ord("Q")):
            break


if __name__ == "__main__":
    try:
        curses.wrapper(draw)
    except KeyboardInterrupt:
        pass
