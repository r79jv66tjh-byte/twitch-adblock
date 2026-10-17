# Changelog

All notable changes to this project.
Format: [Keep a Changelog](https://keepachangelog.com/), versions: [SemVer](https://semver.org/).

## [Unreleased]

- **Install page** (`docs/index.html`, GitHub Pages): guided installation in 3 steps with browser detection, DE/EN.
- README notice: the project is AI-generated (vibecoded), directed, tested and maintained by a human.
- Changelog and code comments are now in English only (README, quick guide and UI stay bilingual).

## [2.2.0] - 2026-10-17

- **Glass design ("Liquid Glass"):** box, panel and notices are see-through with blur behind them, a light glossy edge and soft transitions. On by default; Settings → Display → Glass design switches back to the classic opaque look.
- **Better replacement stream quality:** all player types (embed, site, popout, picture-by-picture, autoplay, frontpage) are checked and the ad-free one with the best quality is used, instead of the first ad-free one. Failed requests are cached for 4 min so Twitch isn't asked again on every playlist fetch.
- **Self-test** lists every player type with quality and ad status (e.g. "embed 1080p ✗ · popout 360p ✓"), also in the log.
- **Minimal layout:** the top row only shows "🛡 42 · 1 h 13 min" and ▾. The panel has three tiles (today · total · saved) and an icon bar: 📊 statistics · 🛟 emergency mode · 🔒 lock · 🐞 help · ⚙ settings – only one area open at a time. Hovering over an icon shows what it does.
- **Hidden dev mode:** click 🐞 five times quickly – then the 🛠 tab appears with status, timestamp/slipped through/sync, self-test, logs and tools (yellow dot = current problem). The dev mode switch in the settings has been removed.
- **Ad status in the top row** instead of pop-ups ("⏳ Ad · replacement 720p", then "✓ 45 s saved"); pop-ups only when the ad is cut out or in fullscreen.
- **Quality of life:** Esc / click outside closes the panel, Alt + A opens/closes it; the box snaps to the window edges, double-click 🛡 = default position; tiles can be switched (today ↔ 7 days, saved total ↔ today); weekly recap; accent colour (purple, blue, green, pink); mini mode; full box only on channel pages; "Reset settings".
- **Quick guide** (`QUICKSTART.md` / `QUICKSTART.de.md`) and **screenshots** in the README (EN and DE).
- 2 new tests (12 in total).

## [2.1.3] - 2026-10-17

- Self-test checks all player types (embed, popout, autoplay) like the blocker and shows which one is ad-free.

## [2.1.2] - 2026-10-17

- Self-test waits for all video workers and uses the best answer (fixes false "stream list not recognised" with two workers).

## [2.1.1] - 2026-10-17

Found via a real user log:

- **Fixed freezing/flickering during ads:** the player requests several playlists at once (e.g. two qualities). The ad state was shared, so it flipped every 2 s between ad and no ad and kept switching between replacement stream and real stream. Now the state is kept per playlist, and an ad break only ends after two ad-free fetches in a row.
- **No more double counting:** Twitch starts two video workers; an ad break reported by several workers/playlists is counted and credited only once.
- **Cancelled requests** (e.g. channel switch) are no longer logged as script errors and not repeated.
- **Faster picture repair right after an ad break** (4 s instead of 10 s); ad breaks whose end is never reported are closed after 45 s.
- 3 new tests for these cases (10 in total).

## [2.1.0] - 2026-10-17

- **🩺 Self-test** (dev mode): checks live whether the channel is open, the video plays, the video worker is connected, the stream list is recognised (incl. address form), Twitch provides a replacement stream (quality, ad-free) and GitHub is reachable – result as ✓/✗ list and in the log.
- **Fullscreen**: notices are shown inside the player (top centre), incl. confirmations for Alt+W / Alt+Z.
- **Replacement stream quality** shown in notice and log (e.g. "720p"); new option "Replacement stream only in full quality" (otherwise cut the ad out).
- **Box fades when idle** (option, on by default).
- **CSV export** of history per day and channels (for Excel).
- **Automatic tests** in the repo (`tests/worker.test.mjs`, 7 scenarios) – run on every push via GitHub Actions.

## [2.0.5] - 2026-10-17

- The expanded panel automatically opens at half the window height and scrolls; the grip at the bottom changes the height freely (double-click = back to half); never taller than the window.

## [2.0.4] - 2026-10-17

- All headings in the panel can be expanded/collapsed (settings groups Display, Blocker, Extras, Backup & restore; history; channels; slipped-through log; events) – the state is saved. Settings groups start collapsed.

## [2.0.3] - 2026-10-17

- New button **🧹 Clear events** in dev mode – empties the event log (counters and slipped-through list are kept).

## [2.0.2] - 2026-10-17

- Recognises Twitch's newer stream list address (`/api/v2/channel/hls/`) – the ad-free replacement stream and the "offline" diagnosis work again; playlists are matched more tolerantly.
- "Time saved" uses at least the measured length of the ad break; the log records which playlist addresses the player uses (without access tokens).

## [2.0.1] - 2026-10-17

- Emergency mode now also hides Twitch's ad buttons ("Ad ⓘ", "Learn more"), which Twitch shows with changing class names.

## [2.0.0] - 2026-10-17

- **Dev mode** (settings or 🛠 button): normal view is simple; troubleshooting tools (events, log, timestamp, sync, reset) only appear in dev mode.
- **Event list** directly in the panel (dev mode).
- **Update notice**: checks GitHub once a day, shows ⬆ in the box; button "Check for updates".
- **"What's new"** notice after an update; version shown in the panel footer and tooltip.
- **"Report a problem"** button: copies the log and opens the bug report form on GitHub; new issue templates.
- **Picture repair**: if the picture freezes, the script jumps to the live picture, restarts the player and reloads the page as a last resort (max. every 5 min).
- **History & channels**: bar chart of the last 7 days and the channels with the most ads.
- **Keyboard shortcuts**: Alt+W = slipped through, Alt+Z = timestamp.
- **Hide extras** (optional): Turbo ads, Prime Gaming banners, stop the front page video.
- **VOD filter** (experimental, optional): cuts out ads embedded in recordings.
- **Backup/restore** counters, history, settings and log as a file.
- GitHub Actions check: syntax and version consistency on every push.

## [1.9.0] - 2026-10-17

- Event log for troubleshooting (stream status incl. "offline / HTTP 404", script, video and player errors); "last problem" in the panel; script errors fall back to the normal stream.

## [1.8.0] - 2026-10-17

- Settings in the panel; "time saved" display; interface in English and German.

## [1.7.0] - 2026-10-17

- Emergency mode – ads that slip through are muted and blurred (🛟 button).

## [1.6.0] - 2026-10-17

- Published on GitHub with automatic updates (@updateURL), MIT license.

## [1.5.0] - 2026-10-17

- Report row: timestamp, slipped through and sync buttons; confirmation inside the button.

## [1.3.0] - 2026-10-17

- Expandable panel, slipped-through log, automatic detection.

## [1.2.0] - 2026-10-17

- Counter box can be dragged and locked.

## [1.1.0] - 2026-10-17

- Counter for blocked ad breaks.

## [1.0.0] - 2026-10-17

- First version: blocks stream ads (replacement stream / cut out) and banners.
