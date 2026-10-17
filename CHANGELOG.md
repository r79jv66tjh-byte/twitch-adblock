# Changelog

🇬🇧 English / 🇩🇪 Deutsch – each entry is listed in both languages.
Format: [Keep a Changelog](https://keepachangelog.com/), versions: [SemVer](https://semver.org/).

## [2.1.1] – 2026-10-17

**EN** (found via a real user log)
- **Fixed freezing/flickering during ads:** the player requests several playlists at once (e.g. two qualities). The ad state was shared, so it flipped every 2 s between ad and no ad and kept switching between replacement stream and real stream. Now the state is kept per playlist, and an ad break only ends after two ad-free fetches in a row.
- **No more double counting:** Twitch starts two video workers; an ad break reported by several workers/playlists is counted and credited only once.
- **Cancelled requests** (e.g. channel switch) are no longer logged as script errors and not repeated.
- **Faster picture repair right after an ad break** (4 s instead of 10 s); ad breaks whose end is never reported are closed after 45 s.
- 3 new tests for these cases (10 in total).

**DE** (gefunden über ein echtes Nutzer-Protokoll)
- **Hängen/Flackern bei Werbung behoben:** Der Player fragt mehrere Playlists gleichzeitig ab (z. B. zwei Qualitäten). Der Werbe-Zustand war gemeinsam und sprang alle 2 s zwischen Werbung und keine Werbung hin und her – mit ständigem Wechsel zwischen Ersatz-Stream und echtem Stream. Jetzt gilt der Zustand pro Playlist, und eine Pause endet erst nach zwei werbefreien Abrufen hintereinander.
- **Keine Doppelzählung mehr:** Twitch startet zwei Video-Worker; eine Pause, die mehrere Worker/Playlists melden, wird nur einmal gezählt und gutgeschrieben.
- **Abgebrochene Anfragen** (z. B. Kanalwechsel) gelten nicht mehr als Script-Fehler und werden nicht wiederholt.
- **Schnellere Bild-Reparatur direkt nach einer Werbepause** (4 s statt 10 s); Pausen ohne gemeldetes Ende werden nach 45 s abgeschlossen.
- 3 neue Tests für diese Fälle (insgesamt 10).

## [2.1.0] – 2026-10-17

**EN**
- **🩺 Self-test** (dev mode): checks live whether the channel is open, the video plays, the video worker is connected, the stream list is recognised (incl. address form), Twitch provides a replacement stream (quality, ad-free) and GitHub is reachable – result as ✓/✗ list and in the log
- **Fullscreen**: notices are shown inside the player (top centre), incl. confirmations for Alt+W / Alt+Z
- **Replacement stream quality** shown in notice and log (e.g. "720p"); new option "Replacement stream only in full quality" (otherwise cut the ad out)
- **Box fades when idle** (option, on by default)
- **CSV export** of history per day and channels (for Excel)
- **Automatic tests** in the repo (`tests/worker.test.mjs`, 7 scenarios) – run on every push via GitHub Actions

**DE**
- **🩺 Selbsttest** (Dev-Modus): prüft live, ob ein Kanal geöffnet ist, das Video läuft, der Video-Worker verbunden ist, die Stream-Liste erkannt wird (inkl. Adressform), Twitch einen Ersatz-Stream liefert (Qualität, werbefrei) und GitHub erreichbar ist – Ergebnis als ✓/✗-Liste und im Protokoll
- **Vollbild**: Hinweise erscheinen im Player (oben mittig), auch Bestätigungen für Alt+W / Alt+Z
- **Qualität des Ersatz-Streams** in Hinweis und Protokoll (z. B. „720p“); neue Option „Ersatz-Stream nur in voller Qualität“ (sonst Werbung herausschneiden)
- **Box im Leerlauf blass** (Option, standardmäßig an)
- **CSV-Export** des Verlaufs pro Tag und der Kanäle (für Excel)
- **Automatische Tests** im Repo (`tests/worker.test.mjs`, 7 Szenarien) – laufen bei jedem Push über GitHub Actions

## [2.0.5] – 2026-10-17

- EN: The expanded panel automatically opens at half the window height and scrolls; the grip at the bottom changes the height freely (double-click = back to half); never taller than the window
- DE: Das aufgeklappte Panel öffnet sich automatisch auf halber Fensterhöhe und scrollt; mit dem Griff unten lässt sich die Höhe frei verstellen (Doppelklick = wieder halbe Höhe); nie höher als das Fenster

## [2.0.4] – 2026-10-17

- EN: All headings in the panel can be expanded/collapsed (settings groups Display, Blocker, Extras, Backup & restore; history; channels; slipped-through log; events) – the state is saved. Settings groups start collapsed.
- DE: Alle Überschriften im Panel lassen sich auf-/zuklappen (Einstellungsgruppen Anzeige, Blocker, Extras, Sichern & Wiederherstellen; Verlauf; Kanäle; Durchgerutscht-Protokoll; Ereignisse) – der Zustand wird gespeichert. Einstellungsgruppen starten zugeklappt.

## [2.0.3] – 2026-10-17

- EN: New button **🧹 Clear events** in dev mode – empties the event log (counters and slipped-through list are kept)
- DE: Neuer Button **🧹 Ereignisse leeren** im Dev-Modus – leert das Ereignis-Protokoll (Zähler und Durchgerutscht-Liste bleiben)

## [2.0.2] – 2026-10-17

- EN: Recognises Twitch's newer stream list address (`/api/v2/channel/hls/`) – the ad-free replacement stream and the "offline" diagnosis work again; playlists are matched more tolerantly
- EN: "Time saved" uses at least the measured length of the ad break; the log records which playlist addresses the player uses (without access tokens)
- DE: Erkennt Twitchs neuere Adresse der Stream-Liste (`/api/v2/channel/hls/`) – werbefreier Ersatz-Stream und „Offline“-Diagnose funktionieren wieder; Playlists werden toleranter zugeordnet
- DE: „Zeit gespart“ zählt mindestens die gemessene Dauer der Werbepause; das Protokoll hält fest, welche Playlist-Adressen der Player nutzt (ohne Zugangsdaten)

## [2.0.1] – 2026-10-17

- EN: Emergency mode now also hides Twitch's ad buttons ("Ad ⓘ", "Learn more"), which Twitch shows with changing class names
- DE: Notfall-Modus blendet jetzt auch Twitchs Werbe-Knöpfe aus („Werbung ⓘ“, „Weitere Informationen“), die Twitch mit wechselnden Klassennamen anzeigt

## [2.0.0] – 2026-10-17

**EN**
- **Dev mode** (settings or 🛠 button): normal view is simple; troubleshooting tools (events, log, timestamp, sync, reset) only appear in dev mode
- **Event list** directly in the panel (dev mode)
- **Update notice**: checks GitHub once a day, shows ⬆ in the box; button "Check for updates"
- **"What's new"** notice after an update; version shown in the panel footer and tooltip
- **"Report a problem"** button: copies the log and opens the bug report form on GitHub; new issue templates
- **Picture repair**: if the picture freezes, the script jumps to the live picture, restarts the player and reloads the page as a last resort (max. every 5 min)
- **History & channels**: bar chart of the last 7 days and the channels with the most ads
- **Keyboard shortcuts**: Alt+W = slipped through, Alt+Z = timestamp
- **Hide extras** (optional): Turbo ads, Prime Gaming banners, stop the front page video
- **VOD filter** (experimental, optional): cuts out ads embedded in recordings
- **Backup/restore** counters, history, settings and log as a file
- GitHub Actions check: syntax and version consistency on every push

**DE**
- **Dev-Modus** (Einstellungen oder 🛠-Button): normale Ansicht ist schlicht; Werkzeuge zur Fehlersuche (Ereignisse, Protokoll, Zeitstempel, Sync, Zurücksetzen) nur im Dev-Modus
- **Ereignisliste** direkt im Panel (Dev-Modus)
- **Update-Hinweis**: prüft einmal am Tag auf GitHub, zeigt ⬆ in der Box; Button „Nach Updates suchen“
- **„Was ist neu“**-Hinweis nach einem Update; Version in der Fußzeile des Panels und im Tooltip
- **„Fehler melden“**-Button: kopiert das Protokoll und öffnet das Fehler-Formular auf GitHub; neue Issue-Vorlagen
- **Bild-Reparatur**: hängt das Bild, springt das Script zum Live-Bild, startet den Player neu und lädt notfalls die Seite neu (max. alle 5 min)
- **Verlauf & Kanäle**: Balken der letzten 7 Tage und die Kanäle mit der meisten Werbung
- **Tastenkürzel**: Alt+W = Durchgerutscht, Alt+Z = Zeitstempel
- **Extras ausblenden** (wahlweise): Turbo-Werbung, Prime-Gaming-Banner, Video auf der Startseite stoppen
- **VOD-Filter** (experimentell, wahlweise): schneidet in Aufzeichnungen eingebettete Werbung heraus
- **Sichern/Wiederherstellen** von Zählern, Verlauf, Einstellungen und Protokoll als Datei
- GitHub-Actions-Prüfung: Syntax und Versionsnummern bei jedem Push

## [1.9.0] – 2026-10-17

- EN: Event log for troubleshooting (stream status incl. "offline / HTTP 404", script, video and player errors); "last problem" in the panel; script errors fall back to the normal stream
- DE: Ereignis-Protokoll zur Fehlersuche (Stream-Status inkl. „offline / HTTP 404“, Script-, Video- und Player-Fehler); „Letztes Problem“ im Panel; bei Script-Fehlern lädt der Stream normal weiter

## [1.8.0] – 2026-10-17

- EN: Settings in the panel; "time saved" display; interface in English and German
- DE: Einstellungen im Panel; Anzeige „Zeit gespart“; Oberfläche auf Deutsch und Englisch

## [1.7.0] – 2026-10-17

- EN: Emergency mode – ads that slip through are muted and blurred (🛟 button)
- DE: Notfall-Modus – durchgerutschte Werbung wird stumm und unscharf geschaltet (🛟-Button)

## [1.6.0] – 2026-10-17

- EN: Published on GitHub with automatic updates (@updateURL), MIT license
- DE: Auf GitHub veröffentlicht mit automatischen Updates (@updateURL), MIT-Lizenz

## [1.5.0] – 2026-10-17

- EN: Report row: timestamp, slipped through and sync buttons; confirmation inside the button
- DE: Melde-Zeile: Zeitstempel, Durchgerutscht und Sync; Bestätigung direkt im Button

## [1.3.0] – 2026-10-17

- EN: Expandable panel, slipped-through log, automatic detection
- DE: Ausklappbares Panel, Durchgerutscht-Protokoll, automatische Erkennung

## [1.2.0] – 2026-10-17

- EN: Counter box can be dragged and locked
- DE: Zähler-Box verschiebbar und sperrbar

## [1.1.0] – 2026-10-17

- EN: Counter for blocked ad breaks
- DE: Zähler für blockierte Werbepausen

## [1.0.0] – 2026-10-17

- EN: First version: blocks stream ads (replacement stream / cut out) and banners
- DE: Erste Version: blockiert Stream-Werbung (Ersatz-Stream / herausschneiden) und Banner
