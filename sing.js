// Seed bank for Cântă (sing) mode. Fixed multiple-choice themes and musical
// styles — no free text anywhere in this app. `seed` is the short phrase
// actually sent to /api/song; `label` is the all-caps card text the kid taps.
window.SING_THEMES = [
  { id: "me", label: "Despre mine", seed: "despre tine, ce te face special" },
  { id: "family", label: "Despre familie și prieteni", seed: "despre familia și prietenii tăi" },
  { id: "adventure", label: "Despre o aventură", seed: "despre o aventură plină de curaj" },
  { id: "pet", label: "Despre animalul preferat", seed: "despre animalul tău preferat" },
  { id: "vacation", label: "Despre o zi de vacanță", seed: "despre cea mai tare zi de vacanță" },
  { id: "courage", label: "Despre curaj", seed: "despre a fi curajos chiar și când ți-e puțin frică" },
];

window.SING_STYLES = [
  { id: "pop", label: "Pop vesel", seed: "pop vesel și energic" },
  { id: "rock", label: "Rock energic", seed: "rock energic, cu ritm puternic" },
  { id: "lofi", label: "Lo-fi calm", seed: "lo-fi calm și relaxant" },
  { id: "dance", label: "Dans / Electro", seed: "dance electro, bun de dansat" },
  { id: "ballad", label: "Baladă blândă", seed: "baladă blândă și duioasă" },
  { id: "hiphop", label: "Hip-hop jucăuș", seed: "hip-hop jucăuș, cu rime amuzante" },
];
