const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const OpenAI = require("openai");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const AREA_LAT = 48.744;
const AREA_LON = 9.106;
const RADIUS = 1200;

/* ----------------------------------------------------
   READ PROJECT GEOJSON FILES
---------------------------------------------------- */
function readGeoJSON(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return { features: [] };
  }
}

const buildingsWeb = readGeoJSON("../data/buildings_web.geojson");
const tile2 = readGeoJSON("../data/observed_buildings_tile2.geojson");
const tile3 = readGeoJSON("../data/observed_buildings_tile3.geojson");
const tile4 = readGeoJSON("../data/observed_buildings_tile4.geojson");

/* ----------------------------------------------------
   BUILDING SUMMARY
---------------------------------------------------- */
function summarizeBuildings() {
  const features = buildingsWeb.features || [];
  const observed = [
    ...(tile2.features || []),
    ...(tile3.features || []),
    ...(tile4.features || []),
  ];

  let good = 0;
  let medium = 0;
  let bad = 0;
  let photos = 0;
  const functions = {};

  features.forEach((f) => {
    const p = f.properties || {};

    if (p.condition === "Good") good++;
    if (p.condition === "Medium") medium++;
    if (p.condition === "Bad") bad++;
    if (p.photo) photos++;

    const func = p.funktion || "Unknown";
    functions[func] = (functions[func] || 0) + 1;
  });

  return {
    webgis_buildings: features.length,
    observed_buildings_from_tiles: observed.length,
    good_condition: good,
    medium_condition: medium,
    bad_condition: bad,
    buildings_with_photos: photos,
    building_functions: functions,
  };
}

/* ----------------------------------------------------
   OPENSTREETMAP / OVERPASS DATA
---------------------------------------------------- */
async function getOSMData() {
  const query = `
    [out:json][timeout:25];
    (
      node(around:${RADIUS},${AREA_LAT},${AREA_LON})["amenity"];
      node(around:${RADIUS},${AREA_LAT},${AREA_LON})["shop"];
      node(around:${RADIUS},${AREA_LAT},${AREA_LON})["tourism"];
      node(around:${RADIUS},${AREA_LAT},${AREA_LON})["public_transport"];
      node(around:${RADIUS},${AREA_LAT},${AREA_LON})["highway"="bus_stop"];

      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["amenity"];
      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["shop"];
      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["tourism"];
      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["building"];
      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["leisure"];
      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["landuse"];
      way(around:${RADIUS},${AREA_LAT},${AREA_LON})["highway"];
    );
    out center tags 300;
  `;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json",
        "User-Agent": "Allmandring-Digital-Twin-Student-Project/1.0",
      },
      body: "data=" + encodeURIComponent(query),
    });

    const text = await response.text();

    if (!text.trim().startsWith("{")) {
      console.error("Overpass did not return JSON:");
      console.error(text.slice(0, 300));
      return [];
    }

    const data = JSON.parse(text);

    return (data.elements || []).map((item) => {
      const lat = item.lat || item.center?.lat || null;
      const lon = item.lon || item.center?.lon || null;

      return {
        osm_id: item.id,
        osm_type: item.type,
        name: item.tags?.name || "Unnamed",
        amenity: item.tags?.amenity || null,
        shop: item.tags?.shop || null,
        tourism: item.tags?.tourism || null,
        building: item.tags?.building || null,
        leisure: item.tags?.leisure || null,
        landuse: item.tags?.landuse || null,
        public_transport: item.tags?.public_transport || null,
        highway: item.tags?.highway || null,
        lat,
        lon,
      };
    });

  } catch (error) {
    console.error("OSM error:", error.message);
    return [];
  }
}

function uniqueByNameAndLocation(items) {
  const seen = new Set();

  return items.filter((item) => {
    const key = `${item.name}-${item.lat}-${item.lon}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function extractOSMUsefulData(osmData) {
  const restaurants = uniqueByNameAndLocation(
    osmData.filter(item =>
      item.amenity === "restaurant" ||
      item.amenity === "cafe" ||
      item.amenity === "fast_food" ||
      item.amenity === "biergarten" ||
      item.amenity === "food_court"
    )
  );

  const busStops = uniqueByNameAndLocation(
    osmData.filter(item =>
      item.highway === "bus_stop" ||
      item.public_transport === "platform" ||
      item.public_transport === "stop_position"
    )
  );

  const shops = uniqueByNameAndLocation(
    osmData.filter(item => item.shop !== null)
  );

  const parking = uniqueByNameAndLocation(
    osmData.filter(item =>
      item.amenity === "parking" ||
      item.amenity === "bicycle_parking"
    )
  );

  const greenAreas = uniqueByNameAndLocation(
    osmData.filter(item =>
      item.leisure === "park" ||
      item.leisure === "garden" ||
      item.landuse === "grass" ||
      item.landuse === "forest" ||
      item.landuse === "recreation_ground"
    )
  );

  const universityFacilities = uniqueByNameAndLocation(
    osmData.filter(item =>
      item.amenity === "university" ||
      item.building === "university" ||
      item.name?.toLowerCase().includes("universität") ||
      item.name?.toLowerCase().includes("university") ||
      item.name?.toLowerCase().includes("institut") ||
      item.name?.toLowerCase().includes("institute")
    )
  );

  return {
    restaurants,
    busStops,
    shops,
    parking,
    greenAreas,
    universityFacilities,
  };
}

/* ----------------------------------------------------
   WIKIPEDIA SOURCE
---------------------------------------------------- */
async function getWikipediaData() {
  const topics = [
    "Stuttgart-Vaihingen",
    "University of Stuttgart",
    "Stuttgart",
  ];

  const results = [];

  for (const topic of topics) {
    try {
      const url =
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;

      const response = await fetch(url);
      const data = await response.json();

      results.push({
        title: data.title,
        summary: data.extract,
      });

    } catch {
      results.push({
        title: topic,
        summary: "No Wikipedia summary available.",
      });
    }
  }

  return results;
}

/* ----------------------------------------------------
   WIKIDATA SOURCE
---------------------------------------------------- */
async function getWikidataData() {
  const sparql = `
    SELECT ?item ?itemLabel ?description WHERE {
      VALUES ?item {
        wd:Q1022
        wd:Q166240
        wd:Q162285
      }
      OPTIONAL {
        ?item schema:description ?description .
        FILTER(LANG(?description) = "en")
      }
      SERVICE wikibase:label {
        bd:serviceParam wikibase:language "en".
      }
    }
  `;

  const url =
    "https://query.wikidata.org/sparql?query=" +
    encodeURIComponent(sparql) +
    "&format=json";

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Allmandring-Digital-Twin-AI/1.0",
      },
    });

    const data = await response.json();

    return data.results.bindings.map((item) => ({
      label: item.itemLabel?.value || "Unknown",
      description: item.description?.value || "No description available",
    }));

  } catch {
    return [];
  }
}

/* ----------------------------------------------------
   UNIVERSITY OF STUTTGART WEBSITE SOURCE
---------------------------------------------------- */
async function getUniversityWebsiteContext() {
  const pages = [
    "https://www.uni-stuttgart.de/en/",
    "https://www.uni-stuttgart.de/en/university/profile/",
  ];

  const results = [];

  for (const page of pages) {
    try {
      const response = await fetch(page);
      const html = await response.text();

      const cleanText = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 2500);

      results.push({
        source: page,
        text: cleanText,
      });

    } catch {
      results.push({
        source: page,
        text: "University website content not available.",
      });
    }
  }

  return results;
}

/* ----------------------------------------------------
   MAP ACTION DETECTION
---------------------------------------------------- */
function detectAction(question) {
  const q = question.toLowerCase();

  if (q.includes("turn on bim") || q.includes("show bim") || q.includes("open bim")) {
    return "turn_on_bim";
  }

  if (q.includes("turn off bim") || q.includes("hide bim")) {
    return "turn_off_bim";
  }

  if (q.includes("bad") || q.includes("inspection") || q.includes("repair") || q.includes("poor")) {
    return "filter_bad_buildings";
  }

  if (q.includes("medium") || q.includes("minor repair") || q.includes("wear and tear")) {
    return "filter_medium_buildings";
  }

  if (q.includes("good building") || q.includes("good condition")) {
    return "filter_good_buildings";
  }

  if (q.includes("show all") || q.includes("all buildings") || q.includes("reset")) {
    return "show_all_buildings";
  }

  if (q.includes("switch to 2d") || q.includes("2d map")) {
    return "switch_to_2d";
  }

  if (q.includes("switch to 3d") || q.includes("3d model")) {
    return "switch_to_3d";
  }

  if (q.includes("restaurant") || q.includes("food") || q.includes("cafe") || q.includes("dining")) {
    return "show_restaurants";
  }

  if (q.includes("bus stop") || q.includes("public transport") || q.includes("station")) {
    return "show_bus_stops";
  }

  return "none";
}

/* ----------------------------------------------------
   PROJECT KNOWLEDGE
---------------------------------------------------- */
const projectKnowledge = `
Allmandring is located in Stuttgart-Vaihingen and is connected to the University of Stuttgart campus environment.

The area includes university-related buildings, research institutes, student housing, residential buildings, green spaces, roads, and public transport connections.

This project is a Web-based 3D City Model and Digital Twin for Allmandring.

The system includes CesiumJS 3D visualization, Leaflet 2D WebGIS, Google photorealistic 3D tiles, BIM model layer, building footprints, field observations, building condition data, photos and notes, building function attributes, OpenStreetMap nearby facilities, Wikipedia/Wikidata context, University of Stuttgart web context, and an AI assistant.

The BIM layer represents a detailed Building Information Model integrated into the 3D city model to demonstrate BIM-GIS integration.

The observation buildings layer represents buildings inspected during fieldwork.

The purpose of the project is urban analysis, field data management, building inspection, digital twin visualization, and interactive decision support.
`;

/* ----------------------------------------------------
   MAIN AI ENDPOINT
---------------------------------------------------- */
app.post("/ask", async (req, res) => {
  console.log("NEW SERVER IS RECEIVING REQUESTS");

  try {
    const question = req.body.question || "";
    const action = detectAction(question);

    const buildingSummary = summarizeBuildings();

    const osmData = await getOSMData();
    const osmUsefulData = extractOSMUsefulData(osmData);

    console.log("TOTAL OSM FEATURES:", osmData.length);
    console.log("RESTAURANTS:", osmUsefulData.restaurants.map(x => x.name));
    console.log("BUS STOPS:", osmUsefulData.busStops.map(x => x.name));

    const wikipediaData = await getWikipediaData();
    const wikidataData = await getWikidataData();
    const universityWebsiteData = await getUniversityWebsiteContext();

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `
You are the AI Assistant inside a WebGIS and 3D Digital Twin platform for Allmandring, Stuttgart.

IMPORTANT:
You are an intelligent local assistant for the Allmandring Digital Twin.

Never mention:
- GeoJSON
- JSON
- FeatureCollection
- source code
- programming
- JavaScript
- HTML
- Cesium
- Leaflet
- database records
- attributes
- raw data

Users are visitors exploring the area.

Answer naturally as a local area and digital twin assistant.

Use these sources:
1. Project knowledge
2. Building condition summary
3. OpenStreetMap extracted nearby data
4. Wikipedia context
5. Wikidata context
6. University of Stuttgart website context

If exact information is unavailable, say:
"This information is not available in the current project data."

If restaurants, bus stops, shops, or facilities have names in OpenStreetMap, list their names clearly.

Keep answers under 120 words.
Be clear, natural, and professional.

PROJECT KNOWLEDGE:
${projectKnowledge}

BUILDING SUMMARY:
${JSON.stringify(buildingSummary, null, 2)}

OPENSTREETMAP EXTRACTED NEARBY DATA:
${JSON.stringify(osmUsefulData, null, 2)}

WIKIPEDIA CONTEXT:
${JSON.stringify(wikipediaData, null, 2)}

WIKIDATA CONTEXT:
${JSON.stringify(wikidataData, null, 2)}

UNIVERSITY OF STUTTGART WEBSITE CONTEXT:
${JSON.stringify(universityWebsiteData, null, 2)}

CHAT HISTORY:
${req.body.history || "No previous chat history."}

USER QUESTION:
${question}

DETECTED MAP ACTION:
${action}

You must start every answer with: VERSION 3 —
Answer naturally now.
      `,
    });

    res.json({
      answer: response.output_text,
      action: action,
      osm: osmUsefulData,
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AI Server running on port ${PORT}`);
});
