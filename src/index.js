import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   BOXNOW STAGE CONFIG
========================= */
const BOXNOW_API_URL = "https://api-stage.boxnow.gr";
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;
const PARTNER_ID = process.env.BOXNOW_PARTNER_ID;

/* =========================
   AUTH TOKEN (CACHE)
========================= */
let cachedToken = null;
let tokenExpiresAt = 0;

async function getBoxNowToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${BOXNOW_API_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("BoxNow auth failed: " + text);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

  return cachedToken;
}

/* =========================
   DELIVERY REQUEST
========================= */
app.post("/api/boxnow/delivery-request", async (req, res) => {
  try {
    const token = await getBoxNowToken();

    const {
      orderNumber,
      invoiceValue,
      paymentMode,
      amountToBeCollected,
      destinationLocationId,
      customerName,
      customerEmail,
      customerPhone,
      items,
    } = req.body;

    if (
      !orderNumber ||
      !destinationLocationId ||
      !customerName ||
      !customerPhone ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const safeMoney = (v) => Number(Number(v).toFixed(2));

    const payload = {
      orderNumber: String(orderNumber),
      invoiceValue: safeMoney(invoiceValue),
      paymentMode: paymentMode || "prepaid",
      amountToBeCollected: safeMoney(amountToBeCollected || 0),
      allowReturn: false,

      origin: {
        locationId: "2", // WAREHOUSE ID (BoxNow οδηγία)
      },

      destination: {
        locationId: String(destinationLocationId), // LOCKER ID
        contactName: String(customerName),
        contactEmail: customerEmail || undefined,
        contactNumber: String(customerPhone),
      },

      items: items.map((item, idx) => ({
        id: String(idx + 1),
        name: String(item.name || "Product"),
        quantity: Number(item.quantity || 1),
        value: safeMoney(item.price || 0),
        weight: Number(item.weight || 1),
      })),
    };

    const response = await fetch(
      `${BOXNOW_API_URL}/delivery-requests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Partner-Id": PARTNER_ID,
        },
        body: JSON.stringify(payload),
      }
    );

    const text = await response.text();

    if (!response.ok) {
      console.error("BOXNOW ERROR:", text);
      return res.status(response.status).json(JSON.parse(text));
    }

    return res.json(JSON.parse(text));
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_, res) => {
  res.send("BoxNow backend running OK");
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`BoxNow backend listening on ${PORT}`)
);


