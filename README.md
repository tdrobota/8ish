# Question Cards

A tiny offline-first PWA of activities for kids. Întrebări/Provocări tap the
screen for a new full-screen, all-caps question or challenge (no repeats
within a session, nothing saved anywhere); Jocuri is a browsable list of
traditional Romanian children's games with illustrated how-to-play
instructions. Built for an iPad Pro 10.5" (2017) running Safari.

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

- `index.html`, `style.css`, `app.js`, `ui.js` — the app (index.html also
  holds the shared SVG pictogram sprite used by Jocuri; ui.js is the shared
  UI kernel — screens registry, icon helper, countdown ring)
- `questions.js` — the ~200-question seed bank
- `challenges.js` — the on-camera dare seed bank
- `games.js` — the traditional Romanian games seed bank (name, description,
  players, and illustrated steps per game)
- `manifest.webmanifest`, `sw.js`, `icons/` — installable, offline PWA support
- `fonts/` — self-hosted Poppins (so it works offline too)
