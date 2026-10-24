# Plate

A home-screen food log for iPhone. Snap or type what you ate, Claude estimates calories and macros,
and an iPhone Shortcut sends your daily steps.

- App: https://perryindustries.github.io/plate/ (GitHub Pages serves `docs/`; pushing `main` deploys)
- Everything is stored on the phone (IndexedDB). With a GitHub token in Settings it is also backed up
  to the private repo `PerryIndustries/plate-data`: `days/<date>.json`, `photos/<id>.jpg`,
  `favorites.json`, `settings.json`, and `steps/<date>_<steps>_<time>.json` written by the Shortcut.
  Moments (waves, check-ins) stay on the phone unless their own backup switch is on; then `moments.json`,
  and with a second switch `audio/<id>.m4a|webm` for voice notes.
- The Claude API key is typed into Settings and never leaves the phone except to call Claude.
  This repo holds code only.

`python tools/make_icons.py` redraws the icons. Bump `CACHE` in `docs/sw.js` when you change the app shell.
