# Question Cards

A tiny offline-first PWA for running kid interviews. Tap the screen for a new
full-screen, all-caps question; no question repeats within a session; nothing
is saved anywhere. Built for an iPad Pro 10.5" (2017) running Safari.

## Use it

Open the deployed URL on the iPad in Safari, then Share → Add to Home Screen.
Once installed, it works with no internet connection.

## Develop locally

No build step — it's plain HTML/CSS/JS. Serve the folder with any static
file server, e.g.:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Structure

- `index.html`, `style.css`, `app.js` — the app
- `questions.js` — the ~200-question seed bank
- `manifest.webmanifest`, `sw.js`, `icons/` — installable, offline PWA support
- `fonts/` — self-hosted Baloo 2 + Nunito (so they work offline too)
