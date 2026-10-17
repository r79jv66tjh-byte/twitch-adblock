# Twitch Adblock – Userscript

🇬🇧 **English** | [🇩🇪 Deutsch](README.de.md)

Blocks or bypasses on twitch.tv:

- **Ads in the stream** (pre-rolls and mid-rolls)
- **Ad banners and overlays** on the page (display ads, "Ad" label, countdown, Amazon ad iframes)

> The script itself is available in **English and German** (switchable in the settings).

## Important – an honest assessment

Twitch inserts ads **server-side directly into the video stream** ("stitched ads"). There is no separate ad address that could simply be blocked like a regular banner. The script therefore works like this:

1. It detects ad segments in the stream playlist.
2. It requests a **second stream** from Twitch with a different player type (e.g. "embed"), which is often ad-free, and plays it during the ad break.
3. If that fails, it **cuts the ad segments out**. The picture may then freeze or go black for the length of the ad – but you won't see or hear the ad.

**No blocker can guarantee that all ads disappear.** Twitch changes its system regularly; the script may then stop working partially or completely overnight. During an ad break the quality may drop briefly (the replacement stream sometimes only has a lower resolution) or the stream may stutter. Ads on VODs (recordings) are not handled.

Legal notice: Blocking ads may violate Twitch's Terms of Service. Use at your own risk. If you want to support streamers, consider subscriptions or Twitch Turbo.

## Installation (Chrome, Edge, Firefox)

### 1. Install a userscript manager

Install **one** of these extensions from your browser's official store:

- **Tampermonkey** (Chrome, Edge, Firefox)
- **Violentmonkey** (Chrome, Edge, Firefox)

### 2. Chrome/Edge only: allow userscripts

Recent versions of Chrome and Edge require an extra permission:

- Right-click the Tampermonkey icon → **Manage extension**
- Turn on **"Allow User Scripts"**
- If that switch doesn't exist: enable **Developer mode** in the top right of `chrome://extensions` or `edge://extensions`.

### 3. Add the script

**Recommended – directly from GitHub (with automatic updates):**
Click **[install twitch-adblock.user.js](https://raw.githubusercontent.com/r79jv66tjh-byte/twitch-adblock/main/twitch-adblock.user.js)**. Tampermonkey/Violentmonkey opens the install page → click **Install**.
Installed this way, Tampermonkey checks for new versions on its own (manually: Tampermonkey icon → **Check for userscript updates**).

**Option A – drag & drop:**
Drag the file `twitch-adblock.user.js` into a browser window. Tampermonkey/Violentmonkey opens the install page → click **Install**.

**Option B – manually:**
1. Click the Tampermonkey icon → **Create a new script**
2. Delete the whole template text
3. Paste the contents of `twitch-adblock.user.js`
4. Save with **Ctrl + S**

### 4. Test

1. **Reload** the Twitch tab (preferably Ctrl + F5).
2. Open a channel. The counter "🛡 0 ad breaks blocked" appears in the bottom left.
3. When an ad starts, a purple notice appears above it:
   - "Ad detected – ad-free replacement stream active" or
   - "Ad is being cut out – picture may freeze briefly"
4. After the ad break you briefly see how much time you saved, e.g. "Ad break over – 45 s saved".

## Language

The script speaks **English and German**. By default it follows your browser language (German browser → German, otherwise English). You can change it in the panel under **⚙ Settings → Language**.

## Ad counter

- In the bottom left the script shows how many **ad breaks** were blocked and how much **time** that saved you, e.g. **"🛡 42 ad breaks · 1 h 13 min saved"**. One ad break can contain several spots; the break is counted.
- **Time saved:** Twitch writes the length of every ad spot into the stream. The script adds these up per ad break (if a length is missing, it measures how long the break took).
- **Move:** drag the box by its top row to wherever you like. The position is saved and survives reloads.
- **Lock:** click the lock. 🔓 = movable, 🔒 = locked (can't be moved by accident). Click again to unlock.
- **🛟 Emergency mode:** the lifebuoy button turns it on (green) and off (grey). When it's on and an ad still slips through (Twitch shows its "Ad" label or countdown), the stream is **muted and heavily blurred** until the ad is over. Afterwards everything returns to how it was, including the volume. On by default. Note: while emergency mode is active, the sound is muted again and again – if you want to hear the ad, turn the mode off briefly.
- **Expand:** click ▾ (or double-click the row). ▴ collapses it again. The state is saved.
- The purple notice always appears directly above the box (or below it if the box is at the very top).
- Everything is stored in twitch.tv's browser storage and survives reloads and browser restarts. Clearing Twitch's site data resets everything.

### Expanded panel

- **Statistics:** this tab / today / total blocked, **time saved today / total** (green) and **slipped through** (red).
- **Last ad break:** time, channel and method (replacement stream or cut out).
- **Report row** with three buttons side by side:
  - **⏱ Timestamp:** copies a timestamp to the clipboard **without saving anything**. Paste with Ctrl + V, e.g.:
    `Ad not blocked – 17/10/2026 16:23:05 – Channel: xyz – last method: replacement stream (40 s ago) – Script 1.8.0`
  - **⚠ Slipped through:** saves the ad you just saw to the slipped-through log and increases the counter by 1.
  - **🔗 Sync:** links the two buttons. With sync on (green), clicking *either* button triggers **both**. Grey = off, the buttons work independently. The setting is saved.
- **Automatic detection:** if Twitch shows its own ad UI in the player (the "Ad" label or countdown), this is saved to the slipped-through log and "Ad slipped through" is shown briefly. This is a hint, not reliable detection: not every ad that slips through is caught this way.
- **Slipped through – log:** list of all cases (manual or automatic), up to 100 are kept.
- **📋 Copy log:** copies the log as text to the clipboard.
- **🗑 Clear slipped through:** deletes the log and resets the "slipped through" counter to 0. Blocked ad breaks and time saved are kept.
- **↺ Reset counters:** resets all counters (including time saved) to 0.
- Both ask for confirmation: on the 1st click the button turns red and shows "Sure? Click again". A 2nd click within 4 seconds performs the action; otherwise nothing happens.

### ⚙ Settings

At the bottom of the expanded panel. All settings are saved immediately – no need to edit the code.

| Setting | What it does |
|---|---|
| **Show notices** | Purple notices (ad detected, time saved, …) on/off |
| **Show numbers in the box** | Off = the box only shows the 🛡 icon (click ▾ to expand it as usual) |
| **Log ads that slip through automatically** | Off = ads detected as slipped through are no longer logged |
| **Emergency mode (mute & blur)** | Same as the 🛟 button |
| **Language** | Automatic (browser), Deutsch or English |

Everything stays **only locally in your browser**. Nothing is sent to Twitch or any server.

## Tips

- Using **uBlock Origin** (or "uBlock Origin Lite" in Chrome) in addition doesn't hurt – it catches more trackers and banners. The script and uBlock work fine together.
- If the stream stays black or won't load: briefly disable the script in the userscript manager and reload the page to check whether the script is the cause.
- If stream ads are no longer blocked, Twitch has probably changed something. Well-maintained alternatives include the "TwitchAdSolutions" (vaft) project on GitHub.

## Files

| File | Contents |
|---|---|
| `twitch-adblock.user.js` | The userscript |
| `README.md` | This guide (English) |
| `README.de.md` | Guide in German |
| `LICENSE` | MIT license |

## License

[MIT](LICENSE) – free to use, modify and share as long as the license notice is kept. No warranty of any kind.

## Publishing a new version (for the repo owner)

1. Make changes in `twitch-adblock.user.js`.
2. **Increase `@version`** at the top of the script (e.g. `1.6.0` → `1.6.1`) and the `VERSION` constant further down as well – Tampermonkey & co. only fetch the update when the version number is higher.
3. Commit and push:
   ```bash
   git add -A
   git commit -m "Version 1.6.1: short description"
   git push
   ```
