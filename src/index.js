import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const API = (process.env.BOXNOW_API_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = null;

const mapPaymentModeToBoxNow = (method) => {
  const normalized = String(method || '').toLowerCase();
  const prepaid = ['card', 'stripe', 'paypal', 'bank_transfer', 'prepaid'];
  const cod = ['cod', 'cash_on_delivery', 'boxnow_cod', 'pay_on_go'];
  if (cod.includes(normalized)) return 'cod';
  if (prepaid.includes(normalized)) return 'prepaid';
  return 'prepaid';
};

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
    const order = req.body || {};
    const paymentMode = mapPaymentModeToBoxNow(order.paymentMode);

    const invoiceValue = Number(order.invoiceValue || 0);
    const amountToBeCollected =
      paymentMode === 'cod'
        ? Number(order.amountToBeCollected ?? invoiceValue).toFixed(2)
        : '0.00';

    const requestBody = {
      typeOfService: 'same-day',
      orderNumber: String(order.orderNumber),
      invoiceValue: invoiceValue.toFixed(2),
      paymentMode,
      amountToBeCollected,
      allowReturn: false,

      origin: { locationId: String(order.originLocationId || '') },

      // ✅ FIX: Pass contactEmail/name/phone inside destination (BoxNow requires destination.contactEmail)
      destination: {
        locationId: String(order.destinationLocationId || ''),
        contactEmail: String(order.contactEmail || ''),
        contactName: String(order.contactName || ''),
        contactPhone: String(order.contactPhone || ''),
      },

      items: (order.items || []).map((item) => ({
        id: String(item.id ?? ''),
        name: String(item.name ?? ''),
        value: String(Number(item.value ?? item.price ?? 0).toFixed(2)),
        weight:
          typeof item.weight === 'string'
            ? Number(item.weight.replace(',', '.'))
            : Number(item.weight || 0),
      })),
    };

    // (Optional but helpful) return a clear 400 before calling BoxNow if email is missing
    if (!requestBody.destination.contactEmail) {
      return res.status(400).json({
        message: 'Missing destination.contactEmail (contactEmail) required for BoxNow',
        receivedKeys: Object.keys(order),
      });
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
app.listen(PORT, () => console.log(`BoxNow server on http://localhost:${PORT}`));


