import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import Stripe from "stripe";

const app = express();

// ✅ CORS locked to your site
app.use(
  cors({
    origin: ["https://godsnbees.com", "https://www.godsnbees.com"],
    credentials: true,
  })
);

// -------------------- STRIPE --------------------
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ✅ Webhook MUST be BEFORE express.json()
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(500).send("Stripe not configured");
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    console.log("✅ payment_intent.succeeded:", pi.id);
  }

  if (event.type === "payment_intent.payment_failed") {
    const pi = event.data.object;
    console.log("❌ payment_intent.payment_failed:", pi.id);
  }

  res.json({ received: true });
});

// ✅ JSON middleware for everything else
app.use(express.json({ limit: "1mb" }));

// ✅ Create PaymentIntent (returns clientSecret)
app.post("/api/stripe/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

    const { amount, currency = "eur", metadata = {} } = req.body || {};
    if (!Number.isInteger(amount) || amount < 50) {
      return res.status(400).json({ error: "Invalid amount (integer cents, min 50)." });
    }

    const pi = await stripe.paymentIntents.create({
      amount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata,
    });

    return res.json({ clientSecret: pi.client_secret, id: pi.id });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// -------------------- ENV --------------------
const RAW_API_URL = (process.env.BOXNOW_API_URL || "").trim();
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

const PARTNER_ID = (process.env.BOXNOW_PARTNER_ID || "").trim();
const DEFAULT_ORIGIN_LOCATION_ID = String(process.env.BOXNOW_WAREHOUSE_ID || "2");

const ALLOW_COD = String(process.env.BOXNOW_ALLOW_COD || "false").toLowerCase() === "true";

// ✅ accept either env var name (so you don't get bitten by naming)
const FORCE_PREPAID = String(
  process.env.BOXNOW_FORCED_PREPAID ?? process.env.BOXNOW_FORCE_PREPAID_ST ?? "false"
).toLowerCase() === "true";

const BOXNOW_ENV = (process.env.BOXNOW_ENV || "").toLowerCase(); // stage | production

// -------------------- MAIL ENV --------------------
const MAIL_HOST = (process.env.MAIL_HOST || "").trim();
const MAIL_PORT = Number(process.env.MAIL_PORT || 465);
const MAIL_SECURE = String(process.env.MAIL_SECURE || "true").toLowerCase() === "true";
const MAIL_USER = (process.env.MAIL_USER || "").trim();
const MAIL_PASS = process.env.MAIL_PASS || "";
const VOUCHER_EMAIL_TO = (process.env.VOUCHER_EMAIL_TO || MAIL_USER).trim();

function mailEnabled() {
  return !!(MAIL_HOST && MAIL_PORT && MAIL_USER && MAIL_PASS && VOUCHER_EMAIL_TO);
}

let mailer = null;
function getMailer() {
  if (!mailEnabled()) return null;
  if (mailer) return mailer;

  mailer = nodemailer.createTransport({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: MAIL_SECURE,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });

  return mailer;
}

// -------------------- HELPERS --------------------
function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

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

function locationBase() {
  const inferred = BOXNOW_ENV || (API_BASE.includes("production") ? "production" : "stage");
  return inferred === "production"
    ? "https://locationapi-production.boxnow.gr/api/v1"
    : "https://locationapi-stage.boxnow.gr/api/v1";
}

function safeMoney(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? x.toFixed(2) : "0.00";
}

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

function mapPaymentModeToBoxNow(method) {
  const normalized = String(method || "").toLowerCase();

  const prepaid = ["card", "stripe", "paypal", "bank_transfer", "bank transfer", "prepaid"];
  const cod = [
    "cod",
    "cash_on_delivery",
    "cash on delivery",
    "boxnow_cod",
    "pay_on_go",
    "pay on go",
    "boxnow_pay_on_the_go",
    "boxnow_pay_on_go",
  ];

  if (cod.includes(normalized)) return "cod";
  if (prepaid.includes(normalized)) return "prepaid";
  return "prepaid";
}

/**
 * Parse KG from number/string:
 * - 0.22 / "0,22" / "0.22kg"
 * - "220" => grams heuristic => 0.22kg
 * - "220g" / "220gr"
 */
function parseKg(x) {
  if (x === null || x === undefined) return 0;

  if (typeof x === "number" && Number.isFinite(x)) {
    return x > 50 ? x / 1000 : x;
  }

  let s = String(x).trim().toLowerCase();
  if (!s) return 0;

  s = s.replace(",", ".");
  s = s.replace(/gr\b/g, "g");

  const hasKg = /\bkg\b/.test(s);
  const hasG = /\bg\b/.test(s);

  const num = Number(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return 0;

  if (hasKg) return num;
  if (hasG) return num / 1000;

  return num > 50 ? num / 1000 : num;
}

/**
 * ✅ TOTAL WEIGHT RULE (integration-first):
 * Priority:
 * 1) order.cartWeightKg (frontend computed canonical)
 * 2) order.weightKg / order.weight (if provided)
 * 3) sum(items[i].weightKg) * qty
 * 4) sum(items[i].weight) * qty
 *
 * NOTE: We do NOT parse titles/names here.
 */
function computeTotalWeightKg(order) {
  const fromCart = parseKg(order?.cartWeightKg);
  if (fromCart > 0) return fromCart;

  const fromOrder = parseKg(order?.weightKg ?? order?.weight);
  if (fromOrder > 0) return fromOrder;

  const items = Array.isArray(order?.items) ? order.items : [];
  let sum = 0;

  for (const it of items) {
    const qty = Math.max(1, Number(it?.quantity || 1) || 1);
    const w = parseKg(it?.weightKg) || parseKg(it?.weight);
    if (w > 0) sum += w * qty;
  }

  return sum;
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
  tokenExpiryMs = Date.now() + Math.max(60, expiresIn - 300) * 1000;
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
    headers: { ...buildHeaders(token), accept: "application/pdf" },
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Label fetch failed (${r.status}): ${txt.slice(0, 200)}`);
  }

  return Buffer.from(await r.arrayBuffer());
}

async function emailVoucherPdf({ orderNumber, pdfBuffer }) {
  const transporter = getMailer();
  if (!transporter) return { sent: false, reason: "mail_not_configured" };

  const toList = VOUCHER_EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);

  await transporter.sendMail({
    from: `"Gods n Bees" <${MAIL_USER}>`,
    to: toList,
    subject: `BOXNOW Voucher – ${orderNumber}`,
    text: `Επισυνάπτεται το BoxNow voucher (PDF) για την αποστολή ${orderNumber}.`,
    attachments: [{ filename: `BOXNOW-${orderNumber}.pdf`, content: pdfBuffer }],
  });

  return { sent: true, to: toList };
}

// -------------------- ROUTES --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

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
    res.status(502).json({ message: "BoxNow destinations error", details: String(e?.message || e) });
  }
});

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
    res.status(502).json({ message: "BoxNow origins error", details: String(e?.message || e) });
  }
});

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
      return res.status(400).json({ error: "Missing customer contact fields (name/email/phone)" });
    }

    const totalWeightKg = computeTotalWeightKg(order);

    if (!Number.isFinite(totalWeightKg) || totalWeightKg <= 0) {
      return res.status(400).json({
        error: "MISSING_WEIGHT",
        message: "Total weight missing/invalid. Provide cartWeightKg or item.weightKg/weight.",
      });
    }

    if (totalWeightKg > 12) {
      return res.status(400).json({
        error: "BOXNOW_MAX_WEIGHT_EXCEEDED",
        maxKg: 12,
        receivedKg: Number(totalWeightKg.toFixed(3)),
      });
    }

    const compartmentSize = totalWeightKg <= 5 ? 2 : 3;

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
          // ✅ IMPORTANT: BoxNow expects weight in KG (decimal)
          weight: Number(totalWeightKg.toFixed(2)),
          compartmentSize,
        },
      ],
    };

    const r = await boxnowApiFetch("/api/v1/delivery-requests", {
      method: "POST",
      body: JSON.stringify(deliveryRequest),
    });

    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);

    // fire-and-forget voucher email
    (async () => {
      try {
        const pdf = await fetchBoxNowLabelPDF(orderNumber);
        await emailVoucherPdf({ orderNumber, pdfBuffer: pdf });
      } catch (err) {
        console.error("✉️ Voucher auto-email failed:", err?.message || err);
      }
    })();

    return res.json({
      boxnowOrderNumber: orderNumber,
      voucher: { pdfUrl: `/api/boxnow/labels/order/${encodeURIComponent(orderNumber)}` },
    });
  } catch (e) {
    res.status(502).json({ message: "BoxNow delivery request error", details: String(e?.message || e) });
  }
});

app.get("/api/boxnow/labels/order/:orderNumber", async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    if (!orderNumber) return res.status(400).json({ error: "Missing orderNumber" });

    const pdf = await fetchBoxNowLabelPDF(orderNumber);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="BOXNOW-${orderNumber}.pdf"`);
    return res.status(200).send(pdf);
  } catch (e) {
    return res.status(502).json({ message: "BoxNow order label error", details: String(e?.message || e) });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`BoxNow server running on port ${PORT}`));



