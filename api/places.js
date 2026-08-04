// Vercel Serverless Function: proxies + caches Overpass (OpenStreetMap) queries.
//
// Doing this server-side instead of calling Overpass straight from the
// browser fixes the reliability problems we kept hitting client-side:
//   - No CORS / mixed-mirror juggling logic needed in the client.
//   - A shared in-memory cache means many visitors searching the same area
//     only cost Overpass ONE real request, not one per visitor.
//   - Cache-Control headers let Vercel's own CDN serve repeat identical
//     searches instantly, worldwide, without even running this function again.
//
// Keep this TAGS array in sync with the one in index.html if categories change.
const TAGS = [
  ["amenity","fast_food","Fast-food","snack",["solo","groupe"]],
  ["amenity","cafe","Café","snack",["solo","duo"]],
  ["shop","bakery","Boulangerie","snack",["solo","famille"]],
  ["amenity","ice_cream","Glacier","snack",["duo","famille"]],
  ["shop","confectionery","Confiserie","snack",["famille","solo"]],
  ["amenity","food_court","Food court","snack",["groupe","solo"]],

  ["amenity","restaurant","Restaurant","restaurant",["duo","famille","groupe"]],
  ["amenity","pub","Pub","restaurant",["groupe","duo"]],
  ["amenity","biergarten","Brasserie","restaurant",["groupe","duo"]],

  ["amenity","bar","Bar","activite",["duo","groupe"]],
  ["amenity","nightclub","Boîte de nuit","activite",["groupe"]],
  ["amenity","cinema","Cinéma","activite",["solo","duo","famille","groupe"]],
  ["amenity","theatre","Théâtre","activite",["duo","famille"]],
  ["tourism","museum","Musée","activite",["solo","duo","famille"]],
  ["leisure","park","Parc","activite",["famille","solo","duo"]],
  ["leisure","playground","Aire de jeux","activite",["famille"]],
  ["leisure","bowling_alley","Bowling","activite",["groupe","famille"]],
  ["leisure","amusement_arcade","Arcade","activite",["groupe","solo"]],
  ["leisure","escape_game","Escape game","activite",["groupe","duo"]],
  ["leisure","water_park","Parc aquatique","activite",["famille","groupe"]],
  ["tourism","zoo","Zoo","activite",["famille"]],
  ["tourism","theme_park","Parc d'attractions","activite",["famille","groupe"]],
  ["leisure","fitness_centre","Salle de sport","activite",["solo","duo"]],
  ["tourism","attraction","Attraction touristique","activite",["famille","duo","groupe","solo"]],
  ["leisure","sports_centre","Centre sportif","activite",["groupe","duo","famille"]],
  ["leisure","ice_rink","Patinoire","activite",["famille","groupe"]],

  ["shop","mall","Centre commercial","shopping",["famille","duo","groupe"]],
  ["shop","supermarket","Supermarché","shopping",["solo","famille"]],
  ["shop","department_store","Grand magasin","shopping",["duo","famille"]],
  ["shop","clothes","Vêtements","shopping",["solo","duo"]],
  ["shop","shoes","Chaussures","shopping",["solo","duo"]],
  ["shop","books","Librairie","shopping",["solo","duo"]],
  ["shop","gift","Cadeaux","shopping",["duo","famille"]],

  ["shop","hairdresser","Coiffeur","bienetre",["solo","duo"]],
  ["shop","beauty","Institut de beauté","bienetre",["solo","duo"]],
  ["shop","massage","Massage","bienetre",["solo","duo"]],
  ["leisure","spa","Spa","bienetre",["duo","solo"]],

  ["amenity","library","Bibliothèque","culture",["solo","famille"]],
  ["tourism","gallery","Galerie d'art","culture",["solo","duo"]],
  ["amenity","arts_centre","Centre culturel","culture",["duo","groupe"]],
  ["historic","monument","Monument","culture",["famille","duo","groupe","solo"]],
  ["historic","castle","Château","culture",["famille","groupe","duo"]],

  ["tourism","viewpoint","Point de vue","nature",["solo","duo","famille"]],
  ["leisure","nature_reserve","Réserve naturelle","nature",["famille","solo","duo"]],
  ["natural","beach","Plage","nature",["famille","groupe","duo"]],
  ["leisure","garden","Jardin","nature",["famille","solo","duo"]],
  ["tourism","picnic_site","Aire de pique-nique","nature",["famille","groupe"]],

  ["tourism","hotel","Hôtel","hebergement",["duo","famille","groupe"]],
  ["tourism","hostel","Auberge de jeunesse","hebergement",["solo","groupe"]],
  ["tourism","guest_house","Chambre d'hôtes","hebergement",["duo","famille"]],
  ["tourism","camp_site","Camping","hebergement",["famille","groupe"]],

  ["amenity","pharmacy","Pharmacie","services",["solo","duo","famille","groupe"]],
  ["amenity","bank","Banque","services",["solo","duo","famille","groupe"]],
  ["amenity","fuel","Station-service","services",["solo","duo","famille","groupe"]],
  ["amenity","post_office","Bureau de poste","services",["solo","duo","famille","groupe"]]
];

const VALID_CATS = new Set(["tout", ...new Set(TAGS.map(t => t[3]))]);
const TOUT_MAX_RADIUS = 5000;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function buildQuery(lat, lon, radius, cat) {
  const relevant = cat === "tout" ? TAGS : TAGS.filter(t => t[3] === cat);
  const byKey = {};
  relevant.forEach(([k, v]) => { (byKey[k] = byKey[k] || []).push(escapeRegex(v)); });
  let parts = "";
  Object.entries(byKey).forEach(([k, values]) => {
    parts += `nwr["${k}"~"^(${values.join("|")})$"](around:${radius},${lat},${lon});`;
  });
  return `[out:json][timeout:8];(${parts});out center tags 700;`;
}

// Warm in-memory cache. Persists across requests as long as the serverless
// instance stays warm — not a guarantee, but a big win when it hits.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchFromMirrors(query) {
  const controllers = OVERPASS_ENDPOINTS.map(() => new AbortController());
  const hardTimer = setTimeout(() => controllers.forEach(c => c.abort()), 8500);
  try {
    const attempts = OVERPASS_ENDPOINTS.map((url, i) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "*/*",
          "User-Agent": "YopiApp/1.0 (+https://github.com/djessimmajor-cloud/yopi-app)"
        },
        body: "data=" + encodeURIComponent(query),
        signal: controllers[i].signal
      }).then(async resp => {
        if (!resp.ok) throw new Error("http_" + resp.status);
        return await resp.json();
      })
    );
    return await Promise.any(attempts);
  } catch (aggErr) {
    throw (aggErr && aggErr.errors && aggErr.errors[0]) || aggErr;
  } finally {
    clearTimeout(hardTimer);
    controllers.forEach(c => c.abort());
  }
}

module.exports = async function handler(req, res) {
  const { lat, lon, radius, cat } = req.query;

  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  const radiusNum = parseInt(radius, 10);

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum) || !Number.isFinite(radiusNum) || !VALID_CATS.has(cat)) {
    res.status(400).json({ error: "invalid_params" });
    return;
  }

  const boundedRadius = Math.min(Math.max(radiusNum, 100), 20000);
  const effRadius = cat === "tout" ? Math.min(boundedRadius, TOUT_MAX_RADIUS) : boundedRadius;
  const rlat = latNum.toFixed(3);
  const rlon = lonNum.toFixed(3);
  const key = `${rlat}|${rlon}|${effRadius}|${cat}`;

  const cached = cache.get(key);
  if (cached && (Date.now() - cached.time) < CACHE_TTL_MS) {
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(cached.data);
    return;
  }

  try {
    const query = buildQuery(rlat, rlon, effRadius, cat);
    const data = await fetchFromMirrors(query);
    cache.set(key, { time: Date.now(), data });
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: "overpass_unavailable", detail: String(err && err.message || err) });
  }
}
