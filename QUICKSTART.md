# Quick guide – Twitch Adblock

🇬🇧 **English** | [🇩🇪 Deutsch](QUICKSTART.de.md) · Full guide: [README.md](README.md)

## Installed in 3 steps

Guided with buttons: **[install page](https://r79jv66tjh-byte.github.io/twitch-adblock/)** – or by hand:

1. Install **Tampermonkey** (or Violentmonkey) from your browser's store.
   Chrome/Edge: right-click the Tampermonkey icon → *Manage extension* → turn on **"Allow User Scripts"**.
2. **[Install the script](https://raw.githubusercontent.com/r79jv66tjh-byte/twitch-adblock/main/twitch-adblock.user.js)** → *Install*.
3. Reload Twitch with **Ctrl + F5** and open a channel – **🛡** appears in the bottom left.

Updates arrive automatically. When a new version exists, the box shows **⬆**.

## The box at a glance

<img src="docs/screenshots/panel-en.png" alt="Box expanded" width="386">

| | |
|---|---|
| **🛡 42 · 1 h 13 min** | 42 ad breaks blocked, 1 h 13 min saved |
| **⏳ Ad · replacement 720p** | An ad is running – you're watching an ad-free stream instead |
| **✓ 45 s saved** | Ad break over |
| **▾** / double-click / **Alt + A** | Open/close the panel |
| **Esc** / click outside | Close the panel |
| **Drag the top row** | Move the box (snaps to edges) · double-click 🛡 = back to bottom left |

**Icon bar** (hover = label):

| 📊 | 🛟 | 🔒 | 🐞 | ⚙ |
|---|---|---|---|---|
| Statistics | Emergency mode | Lock box | Help & report a problem | Settings |

Click the tiles: **today ↔ 7 days**, **saved total ↔ today**.

## If an ad still slips through

- **🛟 Emergency mode** automatically **mutes and blurs** it.
- It is logged automatically; manually: **Alt + W**.
- If it happens often: **🐞 → 🐞 Report a problem** – the log is copied and the GitHub form opens. Paste with **Ctrl + V** into the "Log" field.

## Good to know

- Twitch builds ads right into the stream – **no blocker gets 100 %**. If Twitch changes something, the blocker may stop working for a while.
- All data stays **only in your browser**.
- **Dev mode** for troubleshooting: click **🐞 five times quickly** → **🛠** tab (self-test, logs).
- Look: ⚙ → Display → **Glass design**, **Accent colour**, **Mini mode**.
