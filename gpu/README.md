# GPU-Mining mit PV-Überschuss (RTX 3070)

Ergänzung zum PV-Bitcoin-Projekt: Eine NVIDIA RTX 3070 nutzt den PV-Überschuss zum Mining und wird über den **Shelly Pro 3EM** geregelt. Läuft headless unter Ubuntu.

> ⚠️ Erträge einer einzelnen GPU sind gering (Cent-Bereich/Tag). Das hier ist ein Lern-/Ergänzungsprojekt, das sonst ungenutzten Solar-Überschuss verwertet – kein Ersatz für einen ASIC.

## Was gemined wird – und warum nicht Kaspa

Ursprünglich war Kaspa geplant, aber **GPU-Kaspa lohnt sich nicht mehr** (das Netzwerk wird von ASICs dominiert, und lolMiner hat den Algorithmus entfernt). Stattdessen wird über **NiceHash** der Algorithmus **Autolykos2 (Ergo)** bedient – die Auszahlung erfolgt direkt in **Bitcoin**.

- Miner: **lolMiner**
- Pool/Dienst: **NiceHash**, Stratum `autolykos.auto.nicehash.com:9200`
- Algorithmus: **AUTOLYKOS2** (~160 MH/s auf der 3070)

## Funktionsprinzip

Ein Python-Skript (`pv-gpu-control.py`) fragt alle 20 s den Shelly Pro 3EM ab (`/rpc/EM.GetStatus`, Feld `total_act_power`, negativ = Einspeisung/Überschuss) und regelt daraus:

- **Power-Limit** der GPU per `nvidia-smi -pl` (zwischen **100 und 200 W**)
- **Start/Stop** von lolMiner je nach Überschuss, mit **Hysterese** (EIN ab 160 W, AUS unter 110 W)
- **Auto-Shutdown**: nach 30 min ohne Überschuss und ab 17:00 Uhr fährt der PC herunter

Aufgeweckt wird der PC morgens per **BIOS-RTC-Timer** (z. B. 08:00). So ergibt sich ein autonomer Tagesrhythmus: morgens an → tagsüber PV-geregelt → abends aus → nachts stromlos.

## Dateien

| Datei | Zweck |
|---|---|
| `pv-gpu-control.py` | Steuer-Skript (Shelly lesen, Power-Limit, Miner, Auto-Shutdown) |
| `pv-gpu.service` | systemd-Dienst für Autostart |
| `schaltplan-gpu.svg` | Schalt- und Signalplan des GPU-Setups |

## Einrichtung (Kurzfassung)

Vollständige Schritt-für-Schritt-Anleitung: siehe Haupt-Repo. Kurz:

1. Ubuntu + NVIDIA-Treiber installieren (`sudo ubuntu-drivers install`).
2. lolMiner herunterladen und entpacken; Pfad im Skript bei `MINER_PATH` eintragen.
3. `pv-gpu-control.py` anpassen (`SHELLY_IP`, `USER_ADDR` = NiceHash-Adresse) und ablegen.
4. `sudo apt install python3-requests -y`
5. Als Dienst einrichten:
   ```bash
   sudo cp pv-gpu.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now pv-gpu.service
   journalctl -u pv-gpu.service -f
   ```
6. BIOS: **Power On By RTC** (z. B. 08:00), **ErP Ready = Disabled**. Nach getestetem Aufwecken im Skript `ENABLE_SHUTDOWN = True`.

## Fernzugriff (headless, hinter Mobilfunk-CGNAT)

Da der PC hinter CGNAT steht (keine Portweiterleitung möglich), erfolgt der Zugriff über **Tailscale** (ausgehende Verbindung, kein offener Port):
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Danach ist der PC über seine Tailscale-IP per SSH erreichbar – auch von unterwegs. Nach dem abendlichen Auto-Shutdown ist er bis zum morgendlichen RTC-Start offline (gewollt).

## Hinweise

- Die im Skript hinterlegte **NiceHash-Adresse** ist eine reine Empfangs-/Mining-Adresse – damit kann nur eingezahlt, nichts abgehoben werden.
- **Vorzeichen prüfen:** Einmalig sicherstellen, dass negativer `total_act_power` wirklich Einspeisung bedeutet (hängt vom Einbau der Messzangen ab). Falls invertiert, im Skript `return -r.json()[...]` zu `return r.json()[...]` ändern.
- Am Standort konkurrieren ggf. E-Auto-Laden und Heizung um den Überschuss – der Miner läuft nur, wenn die PV mehr liefert als der übrige Verbrauch.
