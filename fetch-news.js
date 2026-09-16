/**
 * fetch-news.js
 * -----------------------------------------------------------------
 * Récupère les actualités immobilières Bordeaux depuis des flux RSS,
 * les fait trier / résumer par Claude, et écrit le résultat dans
 * bordeaux-immo-news.json (lu ensuite par le widget du dashboard).
 *
 * Lancé une fois par jour par GitHub Actions (voir .github/workflows/
 * daily-news.yml). Aucune clé API n'est écrite en dur : elle est lue
 * depuis la variable d'environnement ANTHROPIC_API_KEY (secret GitHub).
 * -----------------------------------------------------------------
 */

import Parser from "rss-parser";
import fs from "fs/promises";

// ---------------------------------------------------------------
// 1) Liste des flux RSS à surveiller.
//    -> Ajoute/enlève des URLs ici librement. Si un flux ne répond
//       pas ou change d'adresse, le script l'ignore simplement
//       (voir gestion d'erreur plus bas) sans planter.
// ---------------------------------------------------------------
const RSS_FEEDS = [
  { name: "Sud Ouest", url: "https://www.sudouest.fr/economie/immobilier/rss.xml" },
  { name: "Le Figaro Immobilier", url: "https://www.lefigaro.fr/rss/figaro_immobilier.xml" },
  { name: "Le Monde Immobilier", url: "https://www.lemonde.fr/immobilier/rss_full.xml" },
  { name: "20 Minutes Bordeaux", url: "https://www.20minutes.fr/feeds/rss-bordeaux.xml" },
  // Ajoute ici d'autres flux quand tu en trouves de fiables.
];

// Ne garder que les articles publiés dans cette fenêtre (en heures)
const MAX_AGE_HOURS = 72;

const parser = new Parser();

async function collectRawItems() {
  const now = Date.now();
  const items = [];

  for (const feed of RSS_FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      for (const entry of result.items) {
        const pubDate = entry.pubDate ? new Date(entry.pubDate) : null;
        const ageHours = pubDate ? (now - pubDate.getTime()) / 36e5 : null;
        if (ageHours !== null && ageHours > MAX_AGE_HOURS) continue;

        items.push({
          source: feed.name,
          title: entry.title,
          link: entry.link,
          pubDate: pubDate ? pubDate.toISOString() : null,
          summary: (entry.contentSnippet || "").slice(0, 500),
        });
      }
    } catch (err) {
      console.error(`[warn] Flux "${feed.name}" indisponible : ${err.message}`);
      // On continue avec les autres flux plutôt que de faire planter le job
    }
  }

  return items;
}

async function selectAndSummarize(items) {
  if (items.length === 0) {
    return [];
  }

  console.log("Articles bruts envoyés à Claude :");
  console.log(JSON.stringify(items, null, 2));

  const prompt = `Voici une liste brute d'articles d'actualité immobilière récents pour la région de Bordeaux, au format JSON :

${JSON.stringify(items, null, 2)}

Sélectionne jusqu'à 5 articles pertinents pour un agent immobilier professionnel à Bordeaux (prix du marché, réglementation locative, volumes de transactions, quartiers, taux, lois immobilières, mais aussi plus largement toute actualité économique ou locale utile à un professionnel de l'immobilier). Élimine seulement les doublons stricts et le contenu clairement hors-sujet (sport, faits divers, etc.).

IMPORTANT : s'il y a moins de 5 articles disponibles, ou si aucun n'est parfaitement dans le cœur de cible, retourne quand même les articles les plus proches du sujet plutôt qu'une liste vide. Une liste vide n'est acceptable que si TOUS les articles fournis sont totalement hors-sujet (sport, fait divers sans lien avec l'immobilier, etc.).

Réponds UNIQUEMENT avec un JSON valide, sans aucun texte autour, sans balises markdown, au format exact suivant :

[
  {
    "title": "titre court et clair (reformulé si besoin, max 90 caractères)",
    "source": "nom de la source",
    "url": "lien vers l'article",
    "published_label": "ex: il y a 2h / ce matin / hier (déduit de pubDate)"
  }
]`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.content.map((b) => b.text || "").join("\n").trim();

  console.log("Réponse brute de Claude :");
  console.log(text);

  const cleaned = text.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "").trim();

  return JSON.parse(cleaned);
}

async function main() {
  console.log("Collecte des flux RSS...");
  const rawItems = await collectRawItems();
  console.log(`${rawItems.length} article(s) brut(s) collecté(s).`);

  console.log("Tri et résumé via Claude...");
  const curated = await selectAndSummarize(rawItems);

  const output = {
    updated_at: new Date().toISOString(),
    articles: curated,
  };

  await fs.writeFile("bordeaux-immo-news.json", JSON.stringify(output, null, 2), "utf-8");
  console.log(`Écrit ${curated.length} article(s) dans bordeaux-immo-news.json`);
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
