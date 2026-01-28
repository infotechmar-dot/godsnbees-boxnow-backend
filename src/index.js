import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

/**
 * ENV (όπως στην εικόνα σου):
 * BOXNOW_API_URL
 * BOXNOW_CLIENT_ID
 * BOXNOW_CLIENT_SECRET
 * BOXNOW_PARTNER_ID (optional but recommended)
 * BOXNOW_WAREHOUSE_ID (default 2)
 * BOXNOW_ALLOW_COD (true/false)
 * BOXNOW_FORCE_PREPAID_ST (true/false)
 * BOXNOW_ENV (stage/production) optional
 */

// -------------------- ENV / CONFIG --------------------
const RAW_API = (process.env.BOXNOW_API_URL || "").trim();
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

const PARTNER_ID = (process.env.BOXNOW_PARTNER_ID || "").trim();
const DEFAULT_ORIGIN_LOCATION_ID = String(process.env.BOXNOW_WAREHOUSE_ID || "2"); // AnyAPM = 2 :contentReference[oaicite:7]{index=7}

const ALLOW_COD = String(process.env.BOXNOW_ALLOW_COD || "false").toLowerCase() === "true";
const FORCE_PREPAID = String(process.env.BOXNOW_FORCE_PREPAID_ST || "false").toLowerCase() === "true";

// Optional: stage/production override
const BOXNOW_ENV = (process.env.BOXNOW_ENV || "").toLowerCase(); // stage | production

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

/**
 * BOXNOW_API_URL: το θέλουμε ως base χωρίς /api/v1 στο τέλος.
 * Το manual δουλεύει με /api/v1 endpoints. :contentReference[oaicite:8]{index=8}
 * Οπότε εδώ αφαιρούμε αν ο χρήστης έβαλε κατά λάθος /api/v1
 */
function normalizeApiBase(raw) {
  const x = stripTrailingSlash(raw);
  if (!x) return "";
  return x.replace(/\/api\/v1$/i, "");
}

const API_BASE = normalizeApiBase(RAW_API);

// Location API bases (manual) :contentReference[oaicite:9]{index=9}
function locationBase() {
  const env =
    BOXNOW_ENV ||
    (API_BASE.includes("production") ? "production" : "stage");

  return env === "production"
    ? "https://locationapi-production.boxnow.gr/api/v1"
    : "https://locationapi-stage.boxnow.gr/api/v1";
}

function ensureEnv() {
  if (!API_BASE || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing BOXNOW_API_URL / BOXNOW_CLIENT_ID / BOXNOW_CLIENT_SECRET");
  }
}

// -------------------- HELPERS --------------------
function safeMoney(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}

// BoxNow wants full international format e.g. +30... :contentReference[oaicite:10]{index=10}
function normalizePhone(phoneRaw) {
  let p = String(phoneRaw || "").trim().replace(/\s+/g, "");
  if (!p) return "";

  // keep plus, remove other non-digits
  if (p.startsWith("+")) return `+${p.slice(1).replace(/\D/g, "")}`;

  // remove non-digits
  p = p.replace(/\D/g, "");

  // GR mobile: 69xxxxxxxx => +3069xxxxxxxx
  if (p.startsWith("69")) return `+30${p}`;

  // already has country code 30xxxxxxxxxx => +30...
  if (p.startsWith("30")) return `+${p}`;

  // fallback: if user typed 10 digits without cc, assume GR
  if (p.length === 10) return `+30${p}`;

  // last resort
  return `+${p}`;
}

function mapPaymentModeToBoxNow(method) {
  const normalized = String(method || "").toLowerCase();

  // ONLY allowed: prepaid or cod :contentReference[oaicite:11]{index=11}
  const prepaid = ["card", "stripe", "paypal", "bank_transfer", "bank transfer", "prepaid"];
  const cod = ["cod", "cash_on_delivery", "cash on delivery", "boxnow_cod", "pay_on_go", "pay on go"];

  if (cod.includes(normalized)) return "cod";
  if (prepaid.includes(normalized)) return "prepaid";
  return "prepaid";
}

// Parcels: compartmentSize must be 1/2/3 in AnyAPM flows :contentReference[oaicite:12]{index=12}
function normalizeCompartmentSize(x) {
  const n = Number(x);
  if ([1, 2, 3].includes(n)) return n;
  return 2; // medium
}

// Convert kg -> grams (BoxNow weight is numeric; safest is grams)
function normalizeWeightToGrams(w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return 0;

  // if it looks like kg (<=50), convert to grams
  if (n <= 50) return Math.round(n * 1000);

  return Math.round(n);
}

// -------------------- TOKEN CACHE --------------------
let cachedToken = null;
let tokenExpiryMs = 0;

async function authToken() {
  ensureEnv();

  const now = Date.now();
  if (cachedToken && now < tokenExpiryMs - 30_000) return cachedToken;

  // POST /auth-sessions (manual) :contentReference[oaicite:13]{index=13}
  const res = await fetch(`${API_BASE}/api/v1/auth-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BoxNow auth failed: ${res.status} ${text.slice(0, 500)}`);

  const data = JSON.parse(text);
  const token = data.access_token;
  const expiresIn = Number(data.expires_in || 3600);

  if (!token) throw new Error("BoxNow auth missing access_token");

  cachedToken = token;
  tokenExpiryMs = Date.now() + Math.max(60, expiresIn - 300) * 1000; // refresh 5min earlier

  return cachedToken;
}

function boxnowHeaders(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    accept: "application/json",
  };

  // Manual: in partner ambiguity errors, send X-PartnerID :contentReference[oaicite:14]{index=14}
  if (PARTNER_ID) headers["X-PartnerID"] = PARTNER_ID;

  return headers;
}

async function boxnowApiFetch(path, opts = {}) {
  const token = await authToken();
  const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  return fetch(url, {
    ...opts,
    headers: {
      ...boxnowHeaders(token),
      ...(opts.headers || {}),
    },
  });
}

// -------------------- ROUTES --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * ✅ Lockers/Destinations must come from Location API (stage/prod) :contentReference[oaicite:15]{index=15}
 * Your frontend calls this endpoint: /api/boxnow/destinations
 */
app.get("/api/boxnow/destinations", async (req, res) => {
  try {
    const base = locationBase();
    const qs = new URLSearchParams(req.query).toString();
    const url = `${base}/destinations${qs ? `?${qs}` : ""}`;

    const r = await fetch(url, { headers: { accept: "application/json" } });
    const text = await r.text();

    if (!r.ok) return res.status(r.status).send(text);
    res.type("json").send(text);
  } catch (e) {
    console.error("destinations error:", e);
    res.status(502).json({ message: "BoxNow destinations error", details: String(e?.message || e) });
  }
});

/**
 * Optional: origins from Location API
 */
app.get("/api/boxnow/origins", async (req, res) => {
  try {
    const base = locationBase();
    const qs = new URLSearchParams(req.query).toString();
    const url = `${base}/origins${qs ? `?${qs}` : ""}`;

    const r = await fetch(url, { headers: { accept: "application/json" } });
    const text = await r.text();

    if (!r.ok) return res.status(r.status).send(text);
    res.type("json").send(text);
  } catch (e) {
    console.error("origins error:", e);
    res.status(502).json({ message: "BoxNow origins error", details: String(e?.message || e) });
  }
});

/**
 * ✅ Delivery Requests (correct schema)
 * Manual expects:
 * - orderNumber, invoiceValue, paymentMode(prepaid|cod), amountToBeCollected
 * - origin { locationId, contactName/contactEmail/contactNumber, country }
 * - destination { locationId, contactName/contactEmail/contactNumber, country }
 * - items[] are parcels (not cart lines) + compartmentSize 1/2/3 if AnyAPM :contentReference[oaicite:16]{index=16}
 */
app.post("/api/boxnow/delivery-requests", async (req, res) => {
  try {
    const order = req.body || {};

    // Accept both shapes
    const customerName =
      order.customer?.name ??
      order.contactName ??
      `${order.firstName || ""} ${order.lastName || ""}`.trim();

    const customerEmail = order.customer?.email ?? order.contactEmail ?? order.email;
    const customerPhoneRaw = order.customer?.phone ?? order.contactPhone ?? order.phone;
    const customerPhone = normalizePhone(customerPhoneRaw);

    const destinationLocationId =
      order.destinationLocationId ??
      order.destination?.locationId ??
      order.selectedLockerId ??
      order.lockerId;

    const orderNumber = String(order.orderNumber || `ORD-${Date.now()}`);

    const invoiceValueNum = Number(
      order.invoiceValue ?? order.total ?? order.amountToBeCollected ?? 0
    );
    const invoiceValue = safeMoney(invoiceValueNum);

    // paymentMode only prepaid/cod :contentReference[oaicite:17]{index=17}
    let paymentMode = mapPaymentModeToBoxNow(order.paymentMode);

    // hard safety toggles
    if (FORCE_PREPAID) paymentMode = "prepaid";
    if (paymentMode === "cod" && !ALLOW_COD) paymentMode = "prepaid";

    const amountToBeCollected =
      paymentMode === "cod"
        ? safeMoney(order.amountToBeCollected ?? invoiceValueNum)
        : "0.00";

    // Validate required
    if (!destinationLocationId) {
      return res.status(400).json({ error: "Missing destinationLocationId" });
    }
    if (!customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({
        error: "Missing customer contact fields (name/email/phone)",
        received: {
          name: customerName || null,
          email: customerEmail || null,
          phone: customerPhoneRaw || null,
          normalizedPhone: customerPhone || null,
        },
      });
    }

    // Origin: default from env (2 = AnyAPM)
    const originLocationId = String(order.originLocationId || DEFAULT_ORIGIN_LOCATION_ID);

    // Parcel (items = parcels, not cart lines) :contentReference[oaicite:18]{index=18}
    // We'll build ONE parcel based on total weight if provided; fallback 0 (allowed in examples).
    const totalWeightKg =
      Number(order.weightKg ?? order.weight ?? 0) ||
      (Array.isArray(order.items)
        ? order.items.reduce((sum, it) => sum + Number(it.weight ?? it.weightKg ?? 0), 0)
        : 0);

    const compartmentSize = normalizeCompartmentSize(
      order.compartmentSize ??
        order.items?.[0]?.compartmentSize ??
        2
    );

    const parcelWeight = normalizeWeightToGrams(totalWeightKg);

    const requestBody = {
      orderNumber,
      invoiceValue,
      paymentMode,
      amountToBeCollected,

      // origin/destination objects :contentReference[oaicite:19]{index=19}
      origin: {
        locationId: originLocationId,
        contactName: String(customerName),
        contactEmail: String(customerEmail),
        contactNumber: String(customerPhone),
        country: "GR",
      },
      destination: {
        locationId: String(destinationLocationId),
        contactName: String(customerName),
        contactEmail: String(customerEmail),
        contactNumber: String(customerPhone),
        country: "GR",
      },

      // parcels :contentReference[oaicite:20]{index=20}
      items: [
        {
          id: "1",
          name: String(order.parcelName || "Order"),
          value: invoiceValue,
          weight: parcelWeight, // grams (or 0)
          compartmentSize, // 1/2/3
        },
      ],
    };

    // IMPORTANT: AnyAPM (origin=2) requires compartmentSize valid :contentReference[oaicite:21]{index=21}
    if (originLocationId === "2" && ![1, 2, 3].includes(compartmentSize)) {
      return res.status(400).json({ error: "Invalid compartmentSize (must be 1/2/3)" });
    }

    console.log("📦 BoxNow delivery request payload:\n", JSON.stringify(requestBody, null, 2));

    const r = await boxnowApiFetch("/api/v1/delivery-requests", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    const text = await r.text();

    if (!r.ok) {
      console.error("❌ BoxNow API error:", r.status, text);
      return res.status(r.status).send(text);
    }

    res.type("json").send(text);
  } catch (e) {
    console.error("delivery-requests error:", e);
    res.status(502).json({ message: "BoxNow delivery request error", details: String(e?.message || e) });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`BoxNow server running on port ${PORT}`));

