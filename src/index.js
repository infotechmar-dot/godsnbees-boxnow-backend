// src/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// -------------------- Config --------------------
const PORT = process.env.PORT || 10000;

const BOXNOW_ENV = (process.env.BOXNOW_ENV || "").toLowerCase(); // stage | production (optional)
const BOXNOW_API_URL = process.env.BOXNOW_API_URL; // from BoxNow credentials (stage/prod) :contentReference[oaicite:7]{index=7}

const BOXNOW_CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const BOXNOW_CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

const BOXNOW_PARTNER_ID = process.env.BOXNOW_PARTNER_ID || ""; // optional; used as X-PartnerID when needed :contentReference[oaicite:8]{index=8}
const BOXNOW_WAREHOUSE_ID = String(process.env.BOXNOW_WAREHOUSE_ID || "2"); // default AnyAPM=2 :contentReference[oaicite:9]{index=9}

const BOXNOW_ALLOW_COD = String(process.env.BOXNOW_ALLOW_COD || "false").toLowerCase() === "true";
const BOXNOW_FORCE_PREPAID_ST = String(process.env.BOXNOW_FORCE_PREPAID_ST || "false").toLowerCase() === "true";

// Location API bases (manual recommends using these for performance) :contentReference[oaicite:10]{index=10}
function locationBase() {
  // Αν έχεις βάλει BOXNOW_ENV, το χρησιμοποιούμε, αλλιώς κάνουμε heuristic από BOXNOW_API_URL.
  const env =
    BOXNOW_ENV ||
    (String(BOXNOW_API_URL || "").includes("production") ? "production" : "stage");

  return env === "production"
    ? "https://locationapi-production.boxnow.gr/api/v1"
    : "https://locationapi-stage.boxnow.gr/api/v1";
}

// -------------------- CORS --------------------
app.use(
  cors({
    origin: process.env.ALLOW_ORIGIN || "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------- Helpers --------------------
function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

function normalizePhone(phoneRaw) {
  const p = String(phoneRaw || "").trim().replace(/\s+/g, "");
  if (!p) return p;

  if (p.startsWith("+")) return p;
  if (p.startsWith("30")) return `+${p}`;
  if (p.startsWith("69")) return `+30${p}`;
  return p;
}

function toBoxNowCountryCode(countryRaw) {
  const c = String(countryRaw || "").trim().toUpperCase();
  if (!c) return "GR";
  if (c === "GREECE" || c === "EL" || c === "ELLADA" || c === "ΕΛΛΑΔΑ") return "GR";
  return c.length === 2 ? c : "GR";
}

// Weight in BoxNow examples looks like integer and validated up to 10^6 :contentReference[oaicite:11]{index=11}
// Συνήθως πιο ασφαλές: grams.
// Αν έρθει μικρό νούμερο (<= 50) το θεωρούμε kg και το κάνουμε grams.
function normalizeWeightToGrams(weight) {
  const w = Number(weight);
  if (!Number.isFinite(w) || w < 0) return 0;
  if (w === 0) return 0;
  if (w <= 50) return Math.round(w * 1000); // kg -> grams
  return Math.round(w); // assume already grams
}

function normalizeCompartmentSize(size) {
  const s = Number(size);
  if ([1, 2, 3].includes(s)) return s;
  return 2; // default medium
}

// -------------------- Token cache --------------------
let cachedToken = null;
let tokenExpiresAtMs = 0;

async function getAccessToken() {
  mustEnv("BOXNOW_API_URL", BOXNOW_API_URL);
  mustEnv("BOXNOW_CLIENT_ID", BOXNOW_CLIENT_ID);
  mustEnv("BOXNOW_CLIENT_SECRET", BOXNOW_CLIENT_SECRET);

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAtMs - 30_000) return cachedToken;

  // Manual: POST /api/v1/auth-sessions with client credentials 
  const url = `${BOXNOW_API_URL}/auth-sessions`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: BOXNOW_CLIENT_ID,
      client_secret: BOXNOW_CLIENT_SECRET,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BoxNow auth failed (${res.status}): ${text.slice(0, 400)}`);

  const json = JSON.parse(text);
  const accessToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);

  if (!accessToken) throw new Error("BoxNow auth: missing access_token");

  cachedToken = accessToken;
  tokenExpiresAtMs = Date.now() + expiresIn * 1000;

  return cachedToken;
}

function boxnowHeaders(token) {
  const h = {
    "Content-Type": "application/json",
    accept: "application/json",
    Authorization: `Bearer ${token}`,
  };

  // Manual: if ambiguous partner, send X-PartnerID :contentReference[oaicite:13]{index=13}
  if (BOXNOW_PARTNER_ID) h["X-PartnerID"] = BOXNOW_PARTNER_ID;
  return h;
}

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.send("ok"));

/**
 * GET /api/boxnow/destinations
 * Proxy to Location API destinations (lockers)
 * Manual endpoint + stage/prod bases 
 */
app.get("/api/boxnow/destinations", async (req, res) => {
  try {
    const base = locationBase();
    const url = `${base}/destinations`;

    const r = await fetch(url, { headers: { accept: "application/json" } });
    const text = await r.text();

    if (!r.ok) return res.status(r.status).send(text);

    // Location API returns { data: [...] } in examples :contentReference[oaicite:15]{index=15}
    const json = JSON.parse(text);
    return res.json(json);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Failed to load destinations" });
  }
});

/**
 * POST /api/boxnow/delivery-requests
 * Creates BoxNow delivery request using correct schema (origin/destination/items)
 * Manual example :contentReference[oaicite:16]{index=16}
 */
app.post("/api/boxnow/delivery-requests", async (req, res) => {
  try {
    mustEnv("BOXNOW_API_URL", BOXNOW_API_URL);

    const token = await getAccessToken();

    const body = req.body || {};

    // ---- Incoming fields we accept from frontend ----
    const orderNumber = String(body.orderNumber || "");
    const invoiceValue = String(body.invoiceValue ?? "");
    const destinationLocationId = String(body.destinationLocationId || "");

    if (!orderNumber) return res.status(400).json({ error: "Missing orderNumber" });
    if (!invoiceValue) return res.status(400).json({ error: "Missing invoiceValue" });
    if (!destinationLocationId) return res.status(400).json({ error: "Missing destinationLocationId" });

    // Origin: default from env (2 = AnyAPM) :contentReference[oaicite:17]{index=17}
    const originLocationId = String(body.originLocationId || BOXNOW_WAREHOUSE_ID);

    // paymentMode MUST be prepaid/cod :contentReference[oaicite:18]{index=18}
    let paymentMode = String(body.paymentMode || "prepaid").toLowerCase() === "cod" ? "cod" : "prepaid";

    // enforce stage safety if requested
    if (BOXNOW_FORCE_PREPAID_ST) paymentMode = "prepaid";
    if (paymentMode === "cod" && !BOXNOW_ALLOW_COD) paymentMode = "prepaid";

    const amountToBeCollected =
      paymentMode === "cod"
        ? String(body.amountToBeCollected ?? invoiceValue ?? "0.00")
        : "0.00";

    // Contacts
    const contactName = String(body.contactName || "");
    const contactEmail = String(body.contactEmail || "");
    const contactPhone = normalizePhone(body.contactPhone);

    if (!contactName || !contactEmail || !contactPhone) {
      return res.status(400).json({
        error: "Missing contact fields",
        details: "contactName, contactEmail, contactPhone are required",
      });
    }

    // Country
    const country = toBoxNowCountryCode(body.country || "GR");

    // items = parcels (NOT cart lines) :contentReference[oaicite:19]{index=19}
    const itemsArr = Array.isArray(body.items) ? body.items : [];
    const firstParcel = itemsArr.length ? itemsArr[0] : {};

    const compartmentSize = normalizeCompartmentSize(firstParcel.compartmentSize ?? body.compartmentSize);
    const parcelWeightGrams = normalizeWeightToGrams(firstParcel.weight ?? body.weight ?? 0);

    // Size required when origin is AnyAPM directly :contentReference[oaicite:20]{index=20}
    if (String(originLocationId) === "2" && ![1, 2, 3].includes(compartmentSize)) {
      return res.status(400).json({ error: "Invalid compartmentSize (must be 1/2/3)" });
    }

    const deliveryRequestPayload = {
      orderNumber,
      invoiceValue: String(invoiceValue),
      paymentMode,
      amountToBeCollected: String(amountToBeCollected),

      // origin/destination objects (manual) :contentReference[oaicite:21]{index=21}
      origin: {
        contactNumber: contactPhone,
        contactEmail,
        contactName,
        country,
        locationId: String(originLocationId),
      },
      destination: {
        contactNumber: contactPhone,
        contactEmail,
        contactName,
        country,
        locationId: String(destinationLocationId),
      },

      items: [
        {
          id: "1",
          name: String(firstParcel.name || "Order"),
          value: String(firstParcel.value ?? invoiceValue ?? "0.00"),
          compartmentSize,
          weight: parcelWeightGrams, // if unknown pass 0 :contentReference[oaicite:22]{index=22}
        },
      ],
    };

    const url = `${BOXNOW_API_URL}/delivery-requests`;
    const r = await fetch(url, {
      method: "POST",
      headers: boxnowHeaders(token),
      body: JSON.stringify(deliveryRequestPayload),
    });

    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);

    return res.json(JSON.parse(text));
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Delivery request failed" });
  }
});

app.listen(PORT, () => {
  console.log(`BoxNow backend listening on :${PORT}`);
});

