# Lollop

Hop a fox across roads, railways and canals, one tap at a time.

Live at **https://quick-sheet.github.io/Lollop/**

An endless hopper in a blocky 3D world that runs from the countryside to a British high street to the year 2200, then round again. Tap to hop, swipe to step aside or back, hold and let go to lollop two rows at once. Dawdle and a seagull swoops. Everything runs on the phone: no account, no server, no ads.

## Host

GitHub Pages from this repo: **Settings → Pages → Deploy from a branch → main → / (root)**. No build step.

## Install

- **Android (Chrome):** open the live URL and tap **Install** on the banner. If there's no banner, use Chrome ⋮ → **Install app** (on some versions **Add to home screen** → **Install**). Open it from its home-screen icon from then on.
- **iPhone (Safari):** open the live URL, tap **Share** (on iOS 26 it's under the ⋯ beside the address bar), then **Add to Home Screen**. Keep **Open as Web App** on, then tap **Add**. Open it from the home-screen icon, because Safari and the installed app keep separate scores and settings.

## Share

Send the live URL. **Today's route** is the same map on every phone until midnight, so you can compare scores; the share button on the game-over sheet sends a link that opens straight into it.

## Update

1. **Add file → Upload files**, choose the changed files (same names replace the old ones), then **Commit changes**.
2. Wait about a minute, then fully close the app and open it again. If it still looks the same, close and open once more.

Every release bumps **both** markers together: `core.js?v=N` and `gfx.js?v=N` in `index.html`, and `lollop-vN` in `sw.js`. That makes a release arrive whole, even when a phone has kept an older copy of a file.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The screens, controls, sounds and game loop. |
| `core.js` | The rules: the world built row by row from a seed, traffic, trains, boats and what counts as a hit. No graphics, so it can be tested with `node`. |
| `gfx.js` | A small WebGL 2 voxel renderer, the camera, the light for each time of day, and every model. |
| `sw.js` | Offline support and instant updates. |
| `manifest.webmanifest`, icons | Install to the home screen. |

## Good to know

- **Time of day:** the eye icon picks the light. Daylight is closest to the classic look; the six night themes switch on headlights, lit windows and street lamps. Night red and Amber are gentlest on eyes adjusted to the dark.
- **Fair worlds:** every row is built so there is always a way forward. The tests check thousands of rows and have a careful robot play 40 worlds to row 400.
- **Scores and chips** are kept on the phone only.
- **3D graphics:** needs WebGL 2, which current Chrome and Safari have. On slower phones Lollop lowers its own resolution to keep the frame rate up.
- **Android sound on launch:** on some phones, every launch of the installed app plays a sound and shows a Chrome notification saying "Tap to copy the URL for this app". That's Chrome's **Full screen site controls** notification, which the app can't switch off. Long-press the notification and turn that category off.
