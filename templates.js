// Word lists for templated questions in questions.js — entries containing a
// {TOKEN} placeholder (e.g. "Numește 5 {CATEGORIE} care încep cu litera
// {LITERA}!") get a fresh random substitution every time they're drawn (see
// applyTemplate in app.js), so one card definition produces lots of variety
// instead of many near-duplicate fixed cards.

// Letters kept to ones with plenty of easy Romanian answers for a 5-10 year
// old — deliberately excludes rare/hard ones (Q, W, X, Y) and diacritics.
window.TEMPLATE_LETTERS = ["A", "B", "C", "D", "F", "G", "I", "L", "M", "N", "P", "R", "S", "T", "V"];

window.TEMPLATE_CATEGORIES = [
  "animale",
  "fructe",
  "legume",
  "jucării",
  "haine",
  "mâncăruri",
  "obiecte din casă",
  "personaje de desene animate",
  "vehicule",
  "sporturi",
];

window.TEMPLATE_COLORS = ["roșu", "albastru", "verde", "galben", "portocaliu", "mov", "roz", "alb", "negru", "maro"];
