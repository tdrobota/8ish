// Word lists for templated questions in questions.js — entries containing a
// {TOKEN} placeholder (e.g. "Numește 5 {CATEGORIE} care încep cu litera
// {LITERA}!") get a fresh random substitution every time they're drawn (see
// applyTemplate in app.js), so one card definition produces lots of variety
// instead of many near-duplicate fixed cards. i18n.js picks the _RO or _EN
// set at load time based on the active language.

window.TEMPLATE_LETTERS_RO = ["A", "B", "C", "D", "F", "G", "I", "L", "M", "N", "P", "R", "S", "T", "V"];
window.TEMPLATE_LETTERS_EN = ["A", "B", "C", "D", "F", "G", "H", "L", "M", "P", "R", "S", "T", "W"];

window.TEMPLATE_CATEGORIES_RO = [
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
window.TEMPLATE_CATEGORIES_EN = [
  "animals",
  "fruits",
  "vegetables",
  "toys",
  "clothes",
  "foods",
  "things in your house",
  "cartoon characters",
  "vehicles",
  "sports",
];

window.TEMPLATE_COLORS_RO = ["roșu", "albastru", "verde", "galben", "portocaliu", "mov", "roz", "alb", "negru", "maro"];
window.TEMPLATE_COLORS_EN = ["red", "blue", "green", "yellow", "orange", "purple", "pink", "white", "black", "brown"];
