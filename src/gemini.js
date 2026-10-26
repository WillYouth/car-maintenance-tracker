const { generateJson } = require('./lib/gemini');

const CATEGORIES = ['oil_change', 'brakes', 'tyres', 'filters', 'battery', 'inspection', 'fluids', 'bodywork', 'other'];

const DASHBOARD_SYSTEM = `You read a photo of a car instrument cluster (dashboard) and return ONLY a JSON object that matches the response schema.
Rules:
- mileage: the TOTAL odometer as an integer. Assume all distances are in kilometres. Ignore trip meters (TRIP, A, B, DAY) and any numbers with a decimal point. Read the odometer digit by digit.
- fuel_level_percentage: integer 0-100 read from the fuel gauge (F = 100, E = 0). null if no gauge is visible.
- engine_temp_status: "high" if the temperature needle is in the red/H zone or a temperature warning icon is lit, otherwise "normal".
- warning_lights_detected: short lowercase names of ILLUMINATED warning icons only, e.g. "check engine", "oil pressure", "battery", "brake", "tyre pressure", "abs". Ignore grey or unlit icons and the start-up self-test. Use an empty array if none.
- If a value is unreadable, return null. Never guess digits you cannot see; null is always better than a guess.`;

const INVOICE_SYSTEM = `You extract structured data from a photo of a vehicle service invoice or receipt and return ONLY a JSON object that matches the response schema.
Rules:
- service_date: date of service as YYYY-MM-DD. If the year is missing, use the current year. null if absent.
- odometer_km: odometer or mileage printed on the invoice, in km (convert miles). null if absent.
- total_cost: grand total including tax, as a plain number with "." as decimal separator. Strip currency symbols and thousands separators. null if unreadable.
- currency: ISO 4217 code inferred from the symbol or country (e.g. EUR, USD, GBP). null if unknown.
- items: one entry per line of work or part. description is the item as printed, translated to English, at most 80 characters. category is one of: ${CATEGORIES.join(', ')}. Labour-only lines are included with cost null if unpriced.
- Do not invent items. Do not include subtotal, tax, discount or payment lines as items.`;

const DASHBOARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mileage: { type: 'INTEGER', nullable: true },
    fuel_level_percentage: { type: 'INTEGER', nullable: true },
    engine_temp_status: { type: 'STRING', enum: ['normal', 'high'] },
    warning_lights_detected: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['mileage', 'fuel_level_percentage', 'engine_temp_status', 'warning_lights_detected'],
};

const INVOICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    service_date: { type: 'STRING', nullable: true },
    odometer_km: { type: 'INTEGER', nullable: true },
    total_cost: { type: 'NUMBER', nullable: true },
    currency: { type: 'STRING', nullable: true },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          category: { type: 'STRING', enum: CATEGORIES },
          cost: { type: 'NUMBER', nullable: true },
        },
        required: ['description', 'category'],
      },
    },
  },
  required: ['service_date', 'odometer_km', 'total_cost', 'currency', 'items'],
};

function normalizeDashboard(r) {
  const int = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null);
  return {
    mileage: int(r.mileage, 0, 9_999_999),
    fuel_percentage: int(r.fuel_level_percentage, 0, 100),
    engine_temp_status: r.engine_temp_status === 'high' ? 'high' : 'normal',
    warning_lights: (Array.isArray(r.warning_lights_detected) ? r.warning_lights_detected : [])
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim().toLowerCase().slice(0, 40))
      .filter(Boolean)
      .slice(0, 20),
  };
}

function normalizeInvoice(r) {
  const date = typeof r.service_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.service_date) ? r.service_date : null;
  const currency = typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency.toUpperCase()) ? r.currency.toUpperCase() : null;
  return {
    service_date: date,
    odometer_km: Number.isFinite(r.odometer_km) ? Math.round(r.odometer_km) : null,
    total_cost: Number.isFinite(r.total_cost) ? r.total_cost : null,
    currency,
    items: (Array.isArray(r.items) ? r.items : []).slice(0, 50)
      .map((i) => ({
        description: String(i.description ?? '').slice(0, 120),
        category: CATEGORIES.includes(i.category) ? i.category : 'other',
        cost: Number.isFinite(i.cost) ? i.cost : null,
      }))
      .filter((i) => i.description),
  };
}

async function readDashboard(image, mime) {
  const raw = await generateJson({
    system: DASHBOARD_SYSTEM,
    prompt: 'Extract the values from this dashboard photo.',
    image,
    mime,
    schema: DASHBOARD_SCHEMA,
  });
  return normalizeDashboard(raw);
}

async function readInvoice(image, mime) {
  const raw = await generateJson({
    system: INVOICE_SYSTEM,
    prompt: 'Extract the service invoice data from this photo.',
    image,
    mime,
    schema: INVOICE_SCHEMA,
  });
  return normalizeInvoice(raw);
}

module.exports = { readDashboard, readInvoice };
