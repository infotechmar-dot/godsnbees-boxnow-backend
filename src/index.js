import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const API = (process.env.BOXNOW_API_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.BOXNOW_CLIENT_ID;
const CLIENT_SECRET = process.env.BOXNOW_CLIENT_SECRET;

// (προαιρετικό) αν στο δώσανε σαν οδηγία
const PARTNER_ID = process.env.BOXNOW_PARTNER_ID; // π.χ. "9191"

// ✅ BoxNow οδηγία: Warehouse/Origin ID = 2 (stage+prod)
const DEFAULT_ORIGIN_LOCATION_ID = process.env.BOXNOW_WAREHOUSE_ID || '2';

// Επιλογή υπηρεσίας (από screenshots σου: allowed same-day, next-day)
const DEFAULT_TYPE_OF_SERVICE = process.env.BOXNOW_TYPE_OF_SERVICE || 'next-day';

let cachedToken = null;
let tokenExpiry = null;

const mapPaymentModeToBoxNow = (method) => {
  const normalized = String(method || '').toLowerCase();
  const prepaid = ['card', 'stripe', 'paypal', 'bank_transfer', 'bank', 'prepaid'];
  const cod = ['cod', 'cash_on_delivery', 'boxnow_cod', 'pay_on_go', 'pay_on_the_go'];
  if (cod.includes(normalized)) return 'cod';
  if (prepaid.includes(normalized)) return 'prepaid';
  return 'prepaid';
};

const toMoney = (n) => {
  const x = Number(n || 0);
  return (Number.isFinite(x) ? x : 0).toFixed(2);
};

const normalizePhone = (raw) => {
  // BoxNow συνήθως θέλει αριθμό με country code.
  // Θα προσπαθήσουμε να τον κάνουμε +30XXXXXXXXXX για Ελλάδα αν δεν έχει.
  let s = String(raw || '').trim();
  if (!s) return '';

  // κράτα + και ψηφία
  s = s.replace(/[^\d+]/g, '');
  // αν ξεκινά με 00 -> +
  if (s.startsWith('00')) s = '+' + s.slice(2);

  // αν δεν έχει + και είναι 10ψήφιο (ελληνικό κινητό) -> +30
  const digitsOnly = s.replace(/\D/g, '');
  if (!s.startsWith('+') && digitsOnly.length === 10) {
    return `+30${digitsOnly}`;
  }

  // αν είναι ήδη με 30 μπροστά χωρίς + (π.χ. 3069...) -> +30...
  if (!s.startsWith('+') && digitsOnly.startsWith('30')) {
    return `+${digitsOnly}`;
  }

  // αν έχει + αλλά χωρίς άλλα σκουπίδια
  if (s.startsWith('+')) return `+${digitsOnly}`;

  return digitsOnly;
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

  const headers = {
    Authorization: `Bearer ${token}`,
    ...(opts.headers || {}),
  };

  // (προαιρετικό) Αν η BoxNow σου έχει πει για Partner header, βάλε το:
  // Δεν ξέρω αν το θέλει ως header ή body — το αφήνω ασφαλές/προαιρετικό.
  if (PARTNER_ID) {
    headers['X-Partner-Id'] = String(PARTNER_ID);
  }

  return fetch(url, { ...opts, headers });
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

    // ✅ ΚΑΝΟΝΑΣ:
    // prepaid -> amountToBeCollected = 0
    // cod -> amountToBeCollected = invoice
    const invoiceValueNum = Number(order.invoiceValue || 0);
    const invoiceValue = toMoney(invoiceValueNum);

    const amountToBeCollected =
      paymentMode === 'cod'
        ? toMoney(order.amountToBeCollected ?? invoiceValueNum)
        : '0.00';

    const contactEmail = String(order.contactEmail || '').trim();
    const contactName = String(order.contactName || '').trim();
    const contactNumber = normalizePhone(order.contactPhone);

    // Αυτά σε “σκοτώνουν” με 400 αν λείπουν:
    if (!contactEmail || !contactName || !contactNumber) {
      return res.status(400).json({
        message: 'Missing required contact fields for BoxNow',
        details: {
          contactEmail: !!contactEmail,
          contactName: !!contactName,
          contactPhone: !!contactNumber,
        },
      });
    }

    const originLocationId = String(order.originLocationId || DEFAULT_ORIGIN_LOCATION_ID);
    const destinationLocationId = String(order.destinationLocationId || '');

    if (!destinationLocationId) {
      return res.status(400).json({ message: 'Missing destinationLocationId (locker id)' });
    }

    // Items
    const items = (order.items || []).map((item) => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? ''),
      // κάποια schemas θέλουν value με 2 decimals
      value: toMoney(item.value ?? item.price ?? 0),
      // βάρος σε αριθμό
      weight:
        typeof item.weight === 'string'
          ? Number(item.weight.replace(',', '.'))
          : Number(item.weight || 0),
      // αν το schema το δέχεται, κράτα quantity
      quantity: Number(item.quantity || 1),
    }));

    const requestBody = {
      typeOfService: DEFAULT_TYPE_OF_SERVICE, // ✅ next-day (ή same-day)
      orderNumber: String(order.orderNumber || `ORD-${Date.now()}`),

      invoiceValue,
      paymentMode, // prepaid | cod
      amountToBeCollected,

      allowReturn: false,

      // ✅ Οδηγία BoxNow: warehouse/origin id = 2
      origin: { locationId: originLocationId },

      // ✅ Εδώ ήταν το βασικό πρόβλημα πριν: contact fields πρέπει να είναι στο destination
      destination: {
        locationId: destinationLocationId,
        contactEmail,
        contactName,
        contactNumber,
      },

      items,
    };

    // (προαιρετικό) αν το API θέλει partnerId στο body (κάποιες εγκαταστάσεις το θέλουν)
    if (PARTNER_ID) requestBody.partnerId = Number(PARTNER_ID);

    const r = await boxnowFetch('/api/v1/delivery-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const text = await r.text();
    if (!r.ok) {
      // γύρνα πίσω ό,τι λέει το BoxNow για να το βλέπεις καθαρά στο frontend
      return res.status(r.status).send(text);
    }

    res.type('json').send(text);
  } catch (e) {
    console.error('delivery-requests error:', e);
    res.status(502).json({ message: 'BoxNow delivery request error' });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => console.log(`BoxNow server running on port ${PORT}`));

