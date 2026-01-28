import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// -------------------- ENV --------------------
const RAW_API_URL = (process.env.BOXNOW_API_URL || "").trim(); // e.g. https://api-stage.boxnow.gr OR https://api-stage.boxnow.gr/api/v1
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

const PARTNER_ID = (process.env.BOXNOW_PARTNER_ID || "").trim();
const DEFAULT_ORIGIN_LOCATION_ID = String(process.env.BOXNOW_WAREHOUSE_ID || "2"); // AnyAPM=2 :contentReference[oaicite:2]{index=2}

const ALLOW_COD = String(process.env.BOXNOW_ALLOW_COD || "false").toLowerCase() === "true";
const FORCE_PREPAID = String(process.env.BOXNOW_FORCE_PREPAID_ST || "false").toLowerCase() === "true";

// optional override
const BOXNOW_ENV = (process.env.BOXNOW_ENV || "").toLowerCase(); // stage | production

// -------------------- HELPERS --------------------
function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

// normalize to API BASE without /api/v1 at the end
function normalizeApiBase(raw) {
  const x = stripTrailingSlash(raw);
  if (!x) return "";
  return x.replace(/\/api\/v1$/i, "");
}

const API_BASE = normalizeApiBase(RAW_API_URL);

function ensureEnv() {
  if (!API_BASE || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing BOXNOW_API_URL / BOXNOW_CLIENT_ID / BOXNOW_CLIENT_SECRET");
  }
}

// Location API base from manual :contentReference[oaicite:3]{index=3}
function locationBase() {
  const inferred =
    BOXNOW_ENV ||
    (API_BASE.includes("production") ? "production" : "stage");

  return inferred === "production"
    ? "https://locationapi-production.boxnow.gr/api/v1"
    : "https://locationapi-stage.boxnow.gr/api/v1";
}

// Money
function safeMoney(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}

// BoxNow wants international phone format e.g. +30... :contentReference[oaicite:4]{index=4}
function normalizePhone(phoneRaw) {
  let p = String(phoneRaw || "").trim().replace(/\s+/g, "");
  if (!p) return "";

  if (p.startsWith("+")) return `+${p.slice(1).replace(/\D/g, "")}`;

  p = p.replace(/\D/g, "");
  if (p.startsWith("69")) return `+30${p}`;
  if (p.startsWith("30")) return `+${p}`;
  if (p.length === 10) return `+30${p}`;
  return `+${p}`;
}

// only allowed: prepaid | cod :contentReference[oaicite:5]{index=5}
function mapPaymentModeToBoxNow(method) {
  const normalized = String(method || "").toLowerCase();
  const prepaid = ["card", "stripe", "paypal", "bank_transfer", "bank transfer", "prepaid"];
  const cod = ["cod", "cash_on_delivery", "cash on delivery", "boxnow_cod", "pay_on_go", "pay on go"];
  if (cod.includes(normalized)) return "cod";
  if (prepaid.includes(normalized)) return "prepaid";
  return "prepaid";
}

function normalizeCompartmentSize(x) {
  const n = Number(x);
  if ([1, 2, 3].includes(n)) return n;
  return 2;
}

// safest: grams
function normalizeWeightToGrams(w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 50) return Math.round(n * 1000); // kg -> grams
  return Math.round(n);
}

// -------------------- TOKEN CACHE --------------------
let cachedToken = null;
let tokenExpiryMs = 0;

async function authToken() {
  ensureEnv();

  const now = Date.now();
  if (cachedToken && now < tokenExpiryMs - 30_000) return cachedToken;

  // Manual: POST /api/v1/auth-sessions :contentReference[oaicite:6]{index=6}
  const res = await fetch(`${API_BASE}/api/v1/auth-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BoxNow auth failed: ${res.status} ${text.slice(0, 500)}`);

  const data = JSON.parse(text);
  const token = data.access_token;
  const expiresIn = Number(data.expires_in || 3600);

  if (!token) throw new Error("BoxNow auth missing access_token");

  cachedToken = token;
  tokenExpiryMs = Date.now() + Math.max(60, expiresIn - 300) * 1000; // refresh 5 min earlier
  return cachedToken;
}

function boxnowHeaders(token) {
  const h = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    accept: "application/json"
  };
  // Manual recommends X-PartnerID when needed :contentReference[oaicite:7]{index=7}
  if (PARTNER_ID) h["X-PartnerID"] = PARTNER_ID;
  return h;
}

async function boxnowApiFetch(path, opts = {}) {
  const token = await authToken();
  const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      ...boxnowHeaders(token),
      ...(opts.headers || {})
    }
  });
}

// -------------------- ROUTES --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * ✅ DESTINATIONS from Location API (NO AUTH) -> fixes 401
 * Manual location endpoints :contentReference[oaicite:8]{index=8}
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
 * Optional: ORIGINS from Location API (NO AUTH)
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
 * ✅ Delivery Requests - correct schema for BoxNow
 * - origin/destination objects
 * - prepaid/cod only
 * - items are parcels (1 parcel)
 * :contentReference[oaicite:9]{index=9}
 */
app.post("/api/boxnow/delivery-requests", async (req, res) => {
  try {
    const order = req.body || {};

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

    const originLocationId = String(order.originLocationId || DEFAULT_ORIGIN_LOCATION_ID);

    const orderNumber = String(order.orderNumber || `ORD-${Date.now()}`);
    const invoiceValueNum = Number(order.invoiceValue ?? order.total ?? order.amountToBeCollected ?? 0);
    const invoiceValue = safeMoney(invoiceValueNum);

    let paymentMode = mapPaymentModeToBoxNow(order.paymentMode);
    if (FORCE_PREPAID) paymentMode = "prepaid";
    if (paymentMode === "cod" && !ALLOW_COD) paymentMode = "prepaid";

    const amountToBeCollected =
      paymentMode === "cod" ? safeMoney(order.amountToBeCollected ?? invoiceValueNum) : "0.00";

    if (!destinationLocationId) return res.status(400).json({ error: "Missing destinationLocationId" });
    if (!customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({
        error: "Missing customer contact fields (name/email/phone)",
        received: {
          name: customerName || null,
          email: customerEmail || null,
          phone: customerPhoneRaw || null,
          normalizedPhone: customerPhone || null
        }
      });
    }

    // parcel weight (try from weightKg/weight or sum of items)
    const totalWeightKg =
      Number(order.weightKg ?? order.weight ?? 0) ||
      (Array.isArray(order.items)
        ? order.items.reduce((sum, it) => sum + Number(it.weight ?? it.weightKg ?? 0), 0)
        : 0);

    const compartmentSize = normalizeCompartmentSize(
      order.compartmentSize ?? order.items?.[0]?.compartmentSize ?? 2
    );

    // AnyAPM origin=2 requires valid 1/2/3 :contentReference[oaicite:10]{index=10}
    if (originLocationId === "2" && ![1, 2, 3].includes(compartmentSize)) {
      return res.status(400).json({ error: "Invalid compartmentSize (must be 1/2/3)" });
    }

    const deliveryRequest = {
      orderNumber,
      invoiceValue,
      paymentMode,
      amountToBeCollected,

      origin: {
        locationId: originLocationId,
        contactName: String(customerName),
        contactEmail: String(customerEmail),
        contactNumber: String(customerPhone),
        country: "GR"
      },
      destination: {
        locationId: String(destinationLocationId),
        contactName: String(customerName),
        contactEmail: String(customerEmail),
        contactNumber: String(customerPhone),
        country: "GR"
      },

      items: [
        {
          id: "1",
          name: String(order.parcelName || "Order"),
          value: invoiceValue,
          weight: normalizeWeightToGrams(totalWeightKg),
          compartmentSize
        }
      ]
    };

    console.log("📦 BoxNow delivery request payload:\n", JSON.stringify(deliveryRequest, null, 2));

    const r = await boxnowApiFetch("/api/v1/delivery-requests", {
      method: "POST",
      body: JSON.stringify(deliveryRequest)
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
