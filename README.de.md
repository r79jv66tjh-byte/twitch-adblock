# Twitch Adblock – Userscript

[🇬🇧 English](README.md) | 🇩🇪 **Deutsch**

Blockiert bzw. umgeht auf twitch.tv:

- **Werbung im Stream** (Pre-Rolls und Mid-Rolls)
- **Werbebanner und Overlays** auf der Seite (Display-Ads, „Werbung“-Label, Countdown, Amazon-Ad-Iframes)

## Wichtig vorab – ehrliche Einschätzung

Twitch schneidet die Werbung **serverseitig direkt in den Videostream** ein („Stitched Ads“). Es gibt also keine separate Werbe-Adresse, die man einfach sperren könnte, wie bei normalen Bannern. Das Script arbeitet deshalb so:

1. Es erkennt Werbesegmente in der Stream-Playlist.
2. Es fragt bei Twitch einen **zweiten Stream** mit einem anderen Player-Typ an (z. B. „embed“), der oft werbefrei ist, und spielt diesen während der Werbepause ab.
3. Klappt das nicht, **schneidet es die Werbesegmente heraus**. Dann bleibt das Bild ggf. für die Dauer der Werbung stehen oder wird schwarz – aber du siehst/hörst keine Werbung.

**Kein Blocker garantiert, dass alle Werbung verschwindet.** Twitch ändert sein System regelmäßig; dann kann das Script von heute auf morgen teilweise oder gar nicht mehr funktionieren. Während einer Werbepause kann die Qualität kurz sinken (der Ersatz-Stream hat manchmal nur eine niedrigere Auflösung) oder der Stream kurz ruckeln. Werbung auf VODs (Aufzeichnungen) wird nicht behandelt.

Rechtlicher Hinweis: Das Blockieren von Werbung kann gegen die Nutzungsbedingungen von Twitch verstoßen. Die Nutzung erfolgt auf eigene Verantwortung. Wer Streamer unterstützen möchte, kann das über Abos oder Twitch Turbo tun.

## Installation (Chrome, Edge, Firefox)

### 1. Userscript-Manager installieren

Installiere **eine** dieser Erweiterungen aus dem offiziellen Store deines Browsers:

- **Tampermonkey** (Chrome, Edge, Firefox)
- **Violentmonkey** (Chrome, Edge, Firefox)

### 2. Nur bei Chrome/Edge: Userscripts erlauben

Neuere Chrome- und Edge-Versionen verlangen eine zusätzliche Freigabe:

- Rechtsklick auf das Tampermonkey-Symbol → **Erweiterung verwalten**
- Den Schalter **„Nutzerscripts zulassen“** (bzw. „Allow User Scripts“) einschalten
- Falls es diesen Schalter nicht gibt: unter `chrome://extensions` bzw. `edge://extensions` oben rechts den **Entwicklermodus** aktivieren.

### 3. Script hinzufügen

**Empfohlen – direkt von GitHub (mit automatischen Updates):**
Klicke auf **[twitch-adblock.user.js installieren](https://raw.githubusercontent.com/r79jv66tjh-byte/twitch-adblock/main/twitch-adblock.user.js)**. Tampermonkey/Violentmonkey öffnet die Installationsseite → **Installieren** klicken.
So installiert, prüft Tampermonkey regelmäßig selbst, ob es eine neue Version gibt (manuell: Tampermonkey-Symbol → **Nach Userscript-Updates suchen**).

**Variante A – per Drag & Drop:**
Ziehe die Datei `twitch-adblock.user.js` in ein Browserfenster. Tampermonkey/Violentmonkey öffnet die Installationsseite → **Installieren** klicken.

**Variante B – manuell:**
1. Auf das Tampermonkey-Symbol klicken → **Neues Script erstellen**
2. Den kompletten Vorlagentext löschen
3. Den Inhalt von `twitch-adblock.user.js` einfügen
4. Mit **Strg + S** speichern

### 4. Testen

1. Twitch-Tab **neu laden** (am besten Strg + F5).
2. Einen Kanal öffnen. Unten links erscheint der Zähler „🛡 0 Werbepausen blockiert“.
3. Wenn Werbung kommt, erscheint darüber ein lila Hinweis:
   - „Werbung erkannt – werbefreier Ersatz-Stream aktiv“ oder
   - „Werbung wird herausgeschnitten – Bild kann kurz stehen bleiben“

## Werbe-Zähler

- Unten links zeigt das Script an, wie viele **Werbepausen** insgesamt abgefangen wurden (eine Werbepause kann aus mehreren Spots bestehen, gezählt wird die Pause).
- **Verschieben:** Box an der oberen Zeile mit der Maus an die gewünschte Stelle ziehen. Die Position wird gespeichert und bleibt nach dem Neuladen erhalten.
- **Sperren:** Auf das Schloss klicken. 🔓 = verschiebbar, 🔒 = gesperrt (kann nicht mehr versehentlich verschoben werden). Nochmal klicken entsperrt sie wieder.
- **Aufklappen:** Auf ▾ klicken (oder Doppelklick auf die Zeile). ▴ klappt wieder ein. Der Zustand wird gespeichert.
- Der lila Werbe-Hinweis erscheint immer direkt über der Box (oder darunter, wenn sie ganz oben sitzt).
- Gespeichert wird im Browser-Speicher von twitch.tv und überlebt Neuladen und Browser-Neustart. Wer die Website-Daten von Twitch löscht, setzt alles zurück.
- Ausblenden: im Script oben `showCounter: true` auf `false` setzen.

### Aufgeklapptes Panel

- **Statistik:** Dieser Tab / Heute / Insgesamt blockiert, dazu **Durchgerutscht** (rot).
- **Letzte Werbepause:** Uhrzeit, Kanal und Methode (Ersatz-Stream oder herausgeschnitten).
- **Melde-Zeile** mit drei Buttons nebeneinander:
  - **⏱ Zeitstempel:** Kopiert einen Zeitstempel in die Zwischenablage, **ohne etwas zu speichern**. Einfügen mit Strg + V, z. B.:
    `Werbung nicht blockiert – 17.10.2026 16:23:05 – Kanal: xyz – letzte Methode: Ersatz-Stream (vor 40 s) – Script 1.6.0`
  - **⚠ Durchgerutscht:** Speichert die gerade gesehene Werbung im Durchgerutscht-Protokoll und zählt „Durchgerutscht“ um 1 hoch.
  - **🔗 Sync:** Koppelt die beiden Buttons. Ist Sync an (grün), löst ein Klick auf *einen* der beiden Buttons **beide** aus: Zeitstempel kopieren **und** als durchgerutscht speichern. Grau = aus, die Buttons arbeiten einzeln. Die Einstellung wird gespeichert.
- **Automatische Erkennung:** Zeigt Twitch im Player seine eigene Werbe-Anzeige (Label „Werbung“ oder Countdown), wird das im Durchgerutscht-Protokoll gespeichert und kurz „Werbung ist durchgerutscht“ eingeblendet. Das ist ein Anhaltspunkt, keine sichere Erkennung: Nicht jede durchgerutschte Werbung wird so erkannt.
- **Durchgerutscht – Protokoll:** Liste aller Fälle (manuell oder automatisch), bis zu 100 werden gespeichert.
- **📋 Protokoll kopieren:** Kopiert das Durchgerutscht-Protokoll als Text in die Zwischenablage.
- **🗑 Durchgerutscht leeren:** Löscht das Protokoll und setzt den Zähler „Durchgerutscht“ auf 0. Die Zahl der blockierten Werbepausen bleibt erhalten.
- **↺ Zähler zurücksetzen:** Setzt alle Zähler auf 0.
- Beide fragen zur Sicherheit nach: Beim 1. Klick wird der Button rot und zeigt „Sicher? Nochmal klicken“. Ein 2. Klick innerhalb von 4 Sekunden führt die Aktion aus, sonst passiert nichts.

Alles bleibt **nur lokal in deinem Browser**. Es wird nichts an Twitch oder irgendeinen Server geschickt.

## Tipps

- **Zusätzlich uBlock Origin** (bzw. „uBlock Origin Lite“ in Chrome) zu nutzen schadet nicht – das fängt weitere Tracker und Banner ab. Das Script und uBlock vertragen sich.
- Den Hinweis abschalten: im Script oben `showNotice: true` auf `false` setzen.
- Bleibt der Stream schwarz oder lädt nicht: Script im Userscript-Manager kurz deaktivieren und Seite neu laden, um zu prüfen, ob das Script die Ursache ist.
- Funktioniert die Stream-Werbung nicht mehr, hat Twitch vermutlich etwas geändert. Gut gepflegte Alternativen sind z. B. die Projekte „TwitchAdSolutions“ (vaft) auf GitHub.

## Dateien

| Datei | Inhalt |
|---|---|
| `twitch-adblock.user.js` | Das Userscript |
| `README.md` | Anleitung auf Englisch |
| `README.de.md` | Diese Anleitung (Deutsch) |
| `LICENSE` | MIT-Lizenz |

## Lizenz

[MIT](LICENSE) – frei nutzbar, veränderbar und weitergebbar, solange der Lizenzhinweis erhalten bleibt. Ohne jede Gewähr.

## Neue Version veröffentlichen (für den Repo-Besitzer)

1. Änderungen in `twitch-adblock.user.js` machen.
2. Oben im Script **`@version` erhöhen** (z. B. `1.6.0` → `1.6.1`) und die Konstante `VERSION` weiter unten ebenso – nur bei höherer Versionsnummer laden Tampermonkey & Co. das Update.
3. Committen und pushen:
   ```bash
   git add -A
   git commit -m "Version 1.6.1: kurze Beschreibung"
   git push
   ```
