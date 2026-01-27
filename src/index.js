import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const API = (process.env.BOXNOW_API_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;
const PARTNER_ID = process.env.BOXNOW_PARTNER_ID; // STAGE: 9191 (PROD: different)
const ALLOW_COD =
  String(process.env.BOXNOW_ALLOW_COD || 'false').toLowerCase() === 'true'; // STAGE usually: false
const WAREHOUSE_ID = String(process.env.BOXNOW_WAREHOUSE_ID || '2'); // ✅ per BoxNow instructions: 2 in STAGE & PROD

let cachedToken = null;
let tokenExpiry = null;

const mapPaymentModeToBoxNow = (method) => {
  const normalized = String(method || '').toLowerCase();

  // If your frontend ever sends this, keep it explicit; otherwise it maps to cod below.
  if (normalized === 'pay_on_go') return 'pay_on_go';

  const prepaid = ['card', 'stripe', 'paypal', 'bank_transfer', 'prepaid'];
  const cod = ['cod', 'cash_on_delivery', 'boxnow_cod', 'pay_on_go'];

  if (cod.includes(normalized)) return 'cod';
  if (prepaid.includes(normalized)) return 'prepaid';
  return 'prepaid';
};

// Keep only digits (BoxNow often rejects +, spaces, etc.)
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');

// Convert to ASCII/latin (some APIs reject Greek chars)
const toLatin = (str = '') =>
  String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents/diacritics
    .replace(/[^\x00-\x7F]/g, ''); // drop non-ASCII chars

async function authToken() {
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) return cachedToken;

  const res = await fetch(`${API}/api/v1/auth-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BoxNow auth failed: ${res.status} ${text}`);

  const data = JSON.parse(text);
  cachedToken = data.access_token;

  const expiresIn = Number(data.expires_in || 3600);
  tokenExpiry = new Date(Date.now() + Math.max(0, expiresIn - 300) * 1000);
  return cachedToken;
}

async function boxnowFetch(path, opts = {}) {
  const token = await authToken();
  const url = `${API}${path.startsWith('/') ? '' : '/'}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/boxnow/origins', async (_req, res) => {
  try {
    const r = await boxnowFetch('/api/v1/origins');
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    res.type('json').send(text);
  } catch (e) {
    console.error('origins error:', e);
    res.status(502).json({ message: 'BoxNow origins error' });
  }
});

app.get('/api/boxnow/destinations', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await boxnowFetch(`/api/v1/destinations${qs ? `?${qs}` : ''}`);
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    res.type('json').send(text);
  } catch (e) {
    console.error('destinations error:', e);
    res.status(502).json({ message: 'BoxNow destinations error' });
  }
});

app.post('/api/boxnow/delivery-requests', async (req, res) => {
  try {
    if (!PARTNER_ID) {
      return res.status(500).json({
        message: 'BOXNOW_PARTNER_ID is not configured on the server',
      });
    }

    const order = req.body || {};

    // payment mode from frontend
    let paymentMode = mapPaymentModeToBoxNow(order.paymentMode);

    // ✅ If COD/Pay-on-Go isn't enabled in STAGE, force prepaid to avoid P401
    if (!ALLOW_COD && (paymentMode === 'cod' || paymentMode === 'pay_on_go')) {
      paymentMode = 'prepaid';
    }

    const invoiceValue = Number(order.invoiceValue || 0);

    const amountToBeCollected =
      paymentMode === 'cod' || paymentMode === 'pay_on_go'
        ? Number(order.amountToBeCollected ?? invoiceValue).toFixed(2)
        : '0.00';

    const destinationId = String(order.destinationLocationId || '');

    // ✅ per BoxNow instructions:
    // Warehouse ID = 2 (origin), Locker ID = 4 (destination test)
    if (!WAREHOUSE_ID) {
      return res.status(500).json({ message: 'BOXNOW_WAREHOUSE_ID is not configured on the server' });
    }
    if (!destinationId) {
      return res.status(400).json({ message: 'Missing destinationLocationId (Locker ID)' });
    }
    if (WAREHOUSE_ID === destinationId) {
      return res.status(400).json({
        message: 'Warehouse ID and Locker ID must be different (e.g. 2 ≠ 4)',
      });
    }

    const requestBody = {
      partnerId: String(PARTNER_ID),

      // ✅ allowed values per BoxNow: "same-day" or "next-day"
      typeOfService: 'next-day',

      orderNumber: String(order.orderNumber),
      invoiceValue: invoiceValue.toFixed(2),
      paymentMode,
      amountToBeCollected,
      allowReturn: false,

      // ✅ origin must be the Warehouse ID (per BoxNow instructions)
      origin: { locationId: String(WAREHOUSE_ID) },

      destination: {
        locationId: destinationId,
        contactEmail: String(order.contactEmail || ''),
        contactName: toLatin(order.contactName || ''),
        contactNumber: normalizePhone(order.contactPhone || ''),
      },

      items: (order.items || []).map((item) => ({
        id: String(item.id ?? ''),
        name: String(item.name ?? ''),
        value: String(Number(item.value ?? item.price ?? 0).toFixed(2)),
        weight: Math.max(
          0.1,
          typeof item.weight === 'string'
            ? Number(item.weight.replace(',', '.'))
            : Number(item.weight || 0)
        ),
      })),
    };

    // Helpful guards
    if (!requestBody.destination.contactEmail) {
      return res.status(400).json({ message: 'Missing destination.contactEmail' });
    }
    if (!requestBody.destination.contactNumber) {
      return res.status(400).json({ message: 'Missing destination.contactNumber' });
    }

    const r = await boxnowFetch('/api/v1/delivery-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    res.type('json').send(text);
  } catch (e) {
    console.error('delivery-requests error:', e);
    res.status(502).json({ message: 'BoxNow delivery request error' });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`BoxNow server running on port ${PORT}`));






