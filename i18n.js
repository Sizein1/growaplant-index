// Traductions de l'interface (les noms du jeu restent tels quels, ils sont déjà en anglais).
// Dans le HTML : data-i18n="clé" (texte), data-i18n-placeholder, data-i18n-aria, <body data-title="clé">.
const I18N = {
  fr: {
    "lang.switch": "🇬🇧 English",
    "nav.label": "Rubriques", "nav.plants": "🌱 Plantes", "nav.pets": "🐾 Pets",
    "plants.title": "🌱 Index des plantes",
    "plants.sub": "Grow a Plant · index non officiel · gains de base, sans bonus ni mutation",
    "plants.search": "Rechercher une plante…",
    "plants.count": "{n} plante{s} sur {total}",
    "plants.empty": "Aucune plante ne correspond.",
    "plants.grow": "Temps de pousse",
    "pets.title": "🐾 Index des pets",
    "pets.sub": "Grow a Plant · index non officiel · capacités passives de base",
    "pets.search": "Rechercher un pet ou une capacité (ex. Money)…",
    "pets.count": "{n} pet{s} sur {total}",
    "pets.empty": "Aucun pet ne correspond.",
    "pets.none": "Aucune capacité passive",
    "tag.event": "Événement", "tag.fly": "Volant", "tag.notrade": "Non échangeable",
    "sort.label": "Trier", "filter.label": "Filtrer par rareté",
    "sort.rarity": "Tri : rareté", "sort.incomeDesc": "Tri : gain/s décroissant", "sort.incomeAsc": "Tri : gain/s croissant",
    "sort.name": "Tri : nom A → Z", "sort.grow": "Tri : temps de pousse", "sort.powers": "Tri : nombre de capacités",
    "footer": "Données et images tirées du jeu. Site de fan, sans lien avec les créateurs de Grow a Plant.",
  },
  en: {
    "lang.switch": "🇫🇷 Français",
    "nav.label": "Sections", "nav.plants": "🌱 Plants", "nav.pets": "🐾 Pets",
    "plants.title": "🌱 Plant Index",
    "plants.sub": "Grow a Plant · unofficial index · base income, no bonus or mutation",
    "plants.search": "Search a plant…",
    "plants.count": "{n} plant{s} of {total}",
    "plants.empty": "No plant matches.",
    "plants.grow": "Grow time",
    "pets.title": "🐾 Pet Index",
    "pets.sub": "Grow a Plant · unofficial index · base passive abilities",
    "pets.search": "Search a pet or an ability (e.g. Money)…",
    "pets.count": "{n} pet{s} of {total}",
    "pets.empty": "No pet matches.",
    "pets.none": "No passive ability",
    "tag.event": "Event", "tag.fly": "Flying", "tag.notrade": "Untradeable",
    "sort.label": "Sort", "filter.label": "Filter by rarity",
    "sort.rarity": "Sort: rarity", "sort.incomeDesc": "Sort: income/s high → low", "sort.incomeAsc": "Sort: income/s low → high",
    "sort.name": "Sort: name A → Z", "sort.grow": "Sort: grow time", "sort.powers": "Sort: number of abilities",
    "footer": "Data and images taken from the game. Fan site, not affiliated with the creators of Grow a Plant.",
  },
};

// Langue : choix mémorisé, sinon celle du navigateur (français ou anglais)
let LANG = "fr";
try { LANG = localStorage.getItem("lang") || ""; } catch (e) { LANG = ""; }
if (!I18N[LANG]) LANG = (navigator.language || "fr").toLowerCase().startsWith("fr") ? "fr" : "en";

function t(key, vars = {}) {
  let text = (I18N[LANG] && I18N[LANG][key]) ?? I18N.fr[key] ?? key;
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
  return text;
}

function applyI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  if (document.body.dataset.title) document.title = t(document.body.dataset.title).replace(/^\S+\s/, ""); // titre d'onglet sans emoji
  if (typeof window.onLangChange === "function") window.onLangChange(); // la page réaffiche ses cartes
}

// Bouton de langue (id="lang") : bascule FR <-> EN et mémorise le choix
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("lang");
  if (btn) btn.onclick = () => {
    LANG = LANG === "fr" ? "en" : "fr";
    try { localStorage.setItem("lang", LANG); } catch (e) { /* stockage indisponible : le choix vaut pour cette page */ }
    applyI18n();
  };
  applyI18n();
});
