import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const API = (process.env.BOXNOW_API_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

// BoxNow instructions you shared:
// - Warehouse/Origin ID: 2 (stage & production)
const DEFAULT_WAREHOUSE_LOCATION_ID = '2';

// Allowed values (from your error screenshot): same-day, next-day
const ALLOWED_SERVICE_TYPES = new Set(['same-day', 'next-day']);

let cachedToken = null;
let tokenExpiry = null;

const mapPaymentModeToBoxNow = (method) => {
  const normalized = String(method || '').toLowerCase();
  const prepaid = ['card', 'stripe', 'paypal', 'bank_transfer', 'bank transfer', 'prepaid'];
  const cod = ['cod', 'cash_on_delivery', 'cash on delivery', 'boxnow_cod', 'pay_on_go', 'pay on go'];
  if (cod.includes(normalized)) return 'cod';
  if (prepaid.includes(normalized)) return 'prepaid';
  return 'prepaid';
};

function cleanPhoneToDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function safeMoney(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? x.toFixed(2) : '0.00';
}

async function authToken() {
  if (cachedToken && tokenExpiry && new Date() < tokenExpiry) return cachedToken;

  if (!API || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing BOXNOW_API_URL / BOXNOW_CLIENT_ID / BOXNOW_CLIENT_SECRET in env');
  }

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
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * Optional proxy endpoints (keep them if your frontend uses them)
 */
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

/**
 * ✅ FIXED endpoint for delivery requests
 *
 * Accepts BOTH payload styles:
 * A) Your current frontend (top-level contactEmail/contactName/contactPhone)
 * B) A normalized payload (customer: {name,email,phone})
 */
app.post('/api/boxnow/delivery-requests', async (req, res) => {
  try {
    const order = req.body || {};

    // Accept both shapes
    const customerName =
      order.customer?.name ??
      order.contactName ??
      `${order.firstName || ''} ${order.lastName || ''}`.trim();

    const customerEmail = order.customer?.email ?? order.contactEmail ?? order.email;
    const customerPhoneRaw = order.customer?.phone ?? order.contactPhone ?? order.phone;
    const customerPhone = cleanPhoneToDigits(customerPhoneRaw);

    const destinationLocationId =
      order.destinationLocationId ??
      order.destination?.locationId ??
      order.selectedLockerId ??
      order.lockerId;

    const orderNumber = String(order.orderNumber || `ORD-${Date.now()}`);

    // invoiceValue: use invoiceValue if exists else fallback to amountToBeCollected/total
    const invoiceValueNum =
      Number(order.invoiceValue ?? order.total ?? order.amountToBeCollected ?? 0);

    const paymentMode = mapPaymentModeToBoxNow(order.paymentMode);

    // COD logic
    const amountToBeCollected =
      paymentMode === 'cod'
        ? safeMoney(order.amountToBeCollected ?? invoiceValueNum)
        : '0.00';

    // Service type validation (fix P400)
    const typeOfServiceCandidate = String(order.typeOfService || 'next-day');
    const typeOfService = ALLOWED_SERVICE_TYPES.has(typeOfServiceCandidate)
      ? typeOfServiceCandidate
      : 'next-day';

    // HARD validation to avoid P406/P400
    if (!destinationLocationId) {
      return res.status(400).json({ error: 'Missing destinationLocationId' });
    }
    if (!customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({
        error: 'Missing customer contact fields (name/email/phone)',
        received: {
          name: customerName || null,
          email: customerEmail || null,
          phone: customerPhoneRaw || null,
          phoneDigits: customerPhone || null,
        },
      });
    }

    // Items mapping (keep quantity/weight/value safe)
    const items = (order.items || []).map((item) => {
      const quantity = Number(item.quantity ?? 1);
      const weight =
        typeof item.weight === 'string'
          ? Number(item.weight.replace(',', '.'))
          : Number(item.weight ?? item.weightKg ?? 0.3);

      const price = Number(item.price ?? item.value ?? 0);
      return {
        name: String(item.name ?? ''),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 0.3,
        value: safeMoney(price),
      };
    });

    const requestBody = {
      typeOfService,
      orderNumber,
      invoiceValue: safeMoney(invoiceValueNum),
      paymentMode,
      amountToBeCollected,
      allowReturn: false,

      // ✅ Per BoxNow instruction: Warehouse/Origin ID = 2
      origin: { locationId: DEFAULT_WAREHOUSE_LOCATION_ID },

      // ✅ Critical fix: contact fields must be inside destination
      destination: {
        locationId: String(destinationLocationId),
        contactName: String(customerName),
        contactEmail: String(customerEmail),
        contactNumber: String(customerPhone),
      },

      items,
    };

    console.log('📦 BoxNow delivery request payload:\n', JSON.stringify(requestBody, null, 2));

    const r = await boxnowFetch('/api/v1/delivery-requests', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const text = await r.text();

    if (!r.ok) {
      console.error('❌ BoxNow API error:', r.status, text);
      return res.status(r.status).send(text);
    }

    res.type('json').send(text);
  } catch (e) {
    console.error('delivery-requests error:', e);
    res.status(502).json({ message: 'BoxNow delivery request error', details: String(e?.message || e) });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`BoxNow server running on port ${PORT}`));
