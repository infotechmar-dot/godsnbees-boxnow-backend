import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// -------------------- ENV --------------------
const RAW_API_URL = (process.env.BOXNOW_API_URL || "").trim(); // e.g. https://api-stage.boxnow.gr OR https://api-stage.boxnow.gr/api/v1
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

const PARTNER_ID = (process.env.BOXNOW_PARTNER_ID || "").trim();
const DEFAULT_ORIGIN_LOCATION_ID = String(process.env.BOXNOW_WAREHOUSE_ID || "2"); // AnyAPM=2

const ALLOW_COD = String(process.env.BOXNOW_ALLOW_COD || "false").toLowerCase() === "true";
const FORCE_PREPAID = String(process.env.BOXNOW_FORCE_PREPAID_ST || "false").toLowerCase() === "true";

// optional override
const BOXNOW_ENV = (process.env.BOXNOW_ENV || "").toLowerCase(); // stage | production

// -------------------- MAIL ENV --------------------
const MAIL_HOST = (process.env.MAIL_HOST || "").trim();
const MAIL_PORT = Number(process.env.MAIL_PORT || 465);
const MAIL_SECURE = String(process.env.MAIL_SECURE || "true").toLowerCase() === "true";
const MAIL_USER = (process.env.MAIL_USER || "").trim(); // e.g. info@godsnbees.com
const MAIL_PASS = process.env.MAIL_PASS || "";
const VOUCHER_EMAIL_TO = (process.env.VOUCHER_EMAIL_TO || MAIL_USER).trim(); // comma separated allowed

function mailEnabled() {
  return !!(MAIL_HOST && MAIL_PORT && MAIL_USER && MAIL_PASS && VOUCHER_EMAIL_TO);
}

function makeMailer() {
  return nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: MAIL_SECURE,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
}

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

// Location API base (stage/prod)
function locationBase() {
  const inferred = BOXNOW_ENV || (API_BASE.includes("production") ? "production" : "stage");
  return inferred === "production"
    ? "https://locationapi-production.boxnow.gr/api/v1"
    : "https://locationapi-stage.boxnow.gr/api/v1";
}

// Money
function safeMoney(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}

// BoxNow wants international phone format e.g. +30...
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

// only allowed: prepaid | cod
function mapPaymentModeToBoxNow(method) {
  const normalized = String(method || "").toLowerCase();
  const prepaid = ["card", "stripe", "paypal", "bank_transfer", "bank transfer", "prepaid"];
  const cod = ["cod", "cash_on_delivery", "cash on delivery", "boxnow_cod", "pay_on_go", "pay on go", "boxnow_pay_on_the_go"];
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
  tokenExpiryMs = Date.now() + Math.max(60, expiresIn - 300) * 1000; // refresh 5 min earlier
  return cachedToken;
}

function buildHeaders(token) {
  const h = {
    Authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (PARTNER_ID) h["X-PartnerID"] = PARTNER_ID;
  return h;
}

async function boxnowApiFetch(path, opts = {}) {
  const token = await authToken();
  const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      ...buildHeaders(token),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function fetchBoxNowLabelPDF(orderNumber) {
  const token = await authToken();
  const url = `${API_BASE}/api/v1/delivery-requests/${encodeURIComponent(orderNumber)}/label.pdf`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      ...buildHeaders(token),
      accept: "application/pdf",
    },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Label fetch failed (${r.status}): ${txt.slice(0, 200)}`);
  }

  return Buffer.from(await r.arrayBuffer());
}

async function emailVoucherPdf({ orderNumber, pdfBuffer }) {
  if (!mailEnabled()) {
    console.warn("✉️ Mail not configured (MAIL_* / VOUCHER_EMAIL_TO missing). Skipping voucher email.");
    return { sent: false, reason: "mail_not_configured" };
  }

  const transporter = makeMailer();
  const toList = VOUCHER_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);

  await transporter.sendMail({
    from: `"Gods n Bees" <${MAIL_USER}>`,
    to: toList,
    subject: `BOXNOW Voucher – ${orderNumber}`,
    text: `Επισυνάπτεται το BoxNow voucher (PDF) για την αποστολή ${orderNumber}.`,
    attachments: [
      {
        filename: `BOXNOW-${orderNumber}.pdf`,
        content: pdfBuffer,
      },
    ],
  });

  return { sent: true, to: toList };
}

// -------------------- ROUTES --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * ✅ DESTINATIONS from Location API WITH AUTH
 */
app.get("/api/boxnow/destinations", async (req, res) => {
  try {
    const base = locationBase();
    const qs = new URLSearchParams(req.query).toString();
    const url = `${base}/destinations${qs ? `?${qs}` : ""}`;

    const token = await authToken();
    const r = await fetch(url, { headers: buildHeaders(token) });

    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);

    res.type("json").send(text);
  } catch (e) {
    console.error("destinations error:", e);
    res.status(502).json({ message: "BoxNow destinations error", details: String(e?.message || e) });
  }
});

/**
 * Optional: ORIGINS from Location API WITH AUTH
 */
app.get("/api/boxnow/origins", async (req, res) => {
  try {
    const base = locationBase();
    const qs = new URLSearchParams(req.query).toString();
    const url = `${base}/origins${qs ? `?${qs}` : ""}`;

    const token = await authToken();
    const r = await fetch(url, { headers: buildHeaders(token) });

    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);

    res.type("json").send(text);
  } catch (e) {
    console.error("origins error:", e);
    res.status(502).json({ message: "BoxNow origins error", details: String(e?.message || e) });
  }
});

/**
 * ✅ Delivery Requests - creates shipment
 * Also: auto-fetch label PDF and email it (non-fatal)
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
          normalizedPhone: customerPhone || null,
        },
      });
    }

    const totalWeightKg =
      Number(order.weightKg ?? order.weight ?? 0) ||
      (Array.isArray(order.items)
        ? order.items.reduce((sum, it) => sum + Number(it.weight ?? it.weightKg ?? 0), 0)
        : 0);

    const compartmentSize = normalizeCompartmentSize(
      order.compartmentSize ?? order.items?.[0]?.compartmentSize ?? 2
    );

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
        country: "GR",
      },
      destination: {
        locationId: String(destinationLocationId),
        contactName: String(customerName),
        contactEmail: String(customerEmail),
        contactNumber: String(customerPhone),
        country: "GR",
      },
      items: [
        {
          id: "1",
          name: String(order.parcelName || "Order"),
          value: invoiceValue,
          weight: normalizeWeightToGrams(totalWeightKg),
          compartmentSize,
        },
      ],
    };

    console.log("📦 BoxNow delivery request payload:\n", JSON.stringify(deliveryRequest, null, 2));

    const r = await boxnowApiFetch("/api/v1/delivery-requests", {
      method: "POST",
      body: JSON.stringify(deliveryRequest),
    });

    const text = await r.text();

    if (!r.ok) {
      console.error("❌ BoxNow API error:", r.status, text);
      return res.status(r.status).send(text);
    }

    // Parse BoxNow response safely
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    // ✅ Auto-fetch label + email (non-fatal)
    (async () => {
      try {
        const pdf = await fetchBoxNowLabelPDF(orderNumber);
        const mailResult = await emailVoucherPdf({ orderNumber, pdfBuffer: pdf });
        console.log("✉️ Voucher email result:", mailResult);
      } catch (err) {
        console.error("✉️ Voucher auto-email failed:", err?.message || err);
      }
    })();

    // ✅ Always return structured json to frontend
    return res.json({
      boxnowOrderNumber: orderNumber,
      boxnowResponse: parsed ?? text,
      voucher: {
        pdfUrl: `/api/boxnow/labels/order/${encodeURIComponent(orderNumber)}`,
        emailedTo: mailEnabled() ? VOUCHER_EMAIL_TO : null,
      },
    });
  } catch (e) {
    console.error("delivery-requests error:", e);
    res.status(502).json({ message: "BoxNow delivery request error", details: String(e?.message || e) });
  }
});

/**
 * ✅ PDF label for a whole delivery request (orderNumber)
 * GET /api/v1/delivery-requests/{orderNumber}/label.pdf
 */
app.get("/api/boxnow/labels/order/:orderNumber", async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    if (!orderNumber) return res.status(400).json({ error: "Missing orderNumber" });

    const token = await authToken();
    const url = `${API_BASE}/api/v1/delivery-requests/${encodeURIComponent(orderNumber)}/label.pdf`;

    const r = await fetch(url, {
      method: "GET",
      headers: {
        ...buildHeaders(token),
        accept: "application/pdf",
      },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).send(txt || `Label fetch failed (${r.status})`);
    }

    const buf = Buffer.from(await r.arrayBuffer());

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="BOXNOW-${orderNumber}.pdf"`);
    return res.status(200).send(buf);
  } catch (e) {
    console.error("label(order) error:", e);
    return res.status(502).json({ message: "BoxNow order label error", details: String(e?.message || e) });
  }
});

/**
 * ✅ PDF label for a single parcel (parcelId)
 * GET /api/v1/parcels/{parcelId}/label.pdf
 */
app.get("/api/boxnow/labels/parcel/:parcelId", async (req, res) => {
  try {
    const parcelId = String(req.params.parcelId || "").trim();
    if (!parcelId) return res.status(400).json({ error: "Missing parcelId" });

    const token = await authToken();
    const url = `${API_BASE}/api/v1/parcels/${encodeURIComponent(parcelId)}/label.pdf`;

    const r = await fetch(url, {
      method: "GET",
      headers: {
        ...buildHeaders(token),
        accept: "application/pdf",
      },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).send(txt || `Label fetch failed (${r.status})`);
    }

    const buf = Buffer.from(await r.arrayBuffer());

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="BOXNOW-PARCEL-${parcelId}.pdf"`);
    return res.status(200).send(buf);
  } catch (e) {
    console.error("label(parcel) error:", e);
    return res.status(502).json({ message: "BoxNow parcel label error", details: String(e?.message || e) });
  }
});

// ✅ ALWAYS last
const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`BoxNow server running on port ${PORT}`));
