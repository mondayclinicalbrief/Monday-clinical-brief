// netlify/functions/create-checkout.js
//
// Creates a Stripe Checkout Session for multi-specialty signups.
// Called when a user selects a primary specialty + additional extras.
//
// Required environment variables:
//   STRIPE_SECRET_KEY
//
// Expects POST body: { primary: "cardiology", extras: ["neurology", "palliative-care"] }
//
// Pricing:
//   Primary specialty: £20/year (with 28-day free trial)
//   Each additional:   £5/year  (with 28-day free trial)

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ── Config ────────────────────────────────────────────────────────────────────

const TRIAL_DAYS = 28;
const PRIMARY_PRICE_PENCE = 2000;   // £20
const EXTRA_PRICE_PENCE = 500;      // £5
const SITE_URL = process.env.URL || "https://mondayclinicalbrief.co.uk";

const SPECIALTY_NAMES = {
  "acute-medicine": "Acute Medicine",
  "anaesthesiology": "Anaesthetics",
  "cardiology": "Cardiology",
  "cardiothoracic-surgery": "Cardiothoracic Surgery",
  "dermatology": "Dermatology",
  "emergency-medicine": "Emergency Medicine",
  "endocrinology": "Endocrinology",
  "gastroenterology": "Gastroenterology",
  "general-practice": "General Practice / Family Medicine",
  "general-surgery": "General Surgery",
  "geriatric-medicine": "Geriatric Medicine",
  "haematology": "Haematology",
  "infectious-disease": "Infectious Disease",
  "intensive-care": "Intensive Care / Critical Care",
  "nephrology": "Nephrology / Renal Medicine",
  "neurology": "Neurology",
  "neurosurgery": "Neurosurgery",
  "obstetrics-gynaecology": "Obstetrics & Gynaecology",
  "oncology": "Oncology",
  "ophthalmology": "Ophthalmology",
  "orthopaedic-surgery": "Orthopaedic Surgery",
  "paediatrics": "Paediatrics",
  "palliative-care": "Palliative Care",
  "pathology": "Pathology",
  "plastic-surgery": "Plastic & Reconstructive Surgery",
  "psychiatry": "Psychiatry",
  "public-health": "Public Health",
  "radiology": "Radiology",
  "respiratory": "Respiratory Medicine",
  "rheumatology": "Rheumatology",
  "urology": "Urology",
};

function getSpecialtyName(slug) {
  return SPECIALTY_NAMES[slug] || slug.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { primary, extras } = body;

  if (!primary || typeof primary !== "string") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing primary specialty" }) };
  }

  const extraSlugs = Array.isArray(extras) ? extras.filter(s => typeof s === "string" && s !== primary) : [];

  // Build line items — each as an inline price (recurring yearly with trial)
  const lineItems = [];

  // Primary specialty
  lineItems.push({
    price_data: {
      currency: "gbp",
      product_data: {
        name: "Monday Clinical Brief — " + getSpecialtyName(primary),
        description: "Weekly journal digest for " + getSpecialtyName(primary),
      },
      unit_amount: PRIMARY_PRICE_PENCE,
      recurring: { interval: "year" },
    },
    quantity: 1,
  });

  // Additional specialties
  for (const slug of extraSlugs) {
    lineItems.push({
      price_data: {
        currency: "gbp",
        product_data: {
          name: "Additional specialty — " + getSpecialtyName(slug),
          description: "Weekly journal digest for " + getSpecialtyName(slug),
        },
        unit_amount: EXTRA_PRICE_PENCE,
        recurring: { interval: "year" },
      },
      quantity: 1,
    });
  }

  // client_reference_id: comma-separated list of all specialties (primary first)
  const allSlugs = [primary, ...extraSlugs];
  const clientRefId = allSlugs.join(",");

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: lineItems,
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
      },
      client_reference_id: clientRefId,
      success_url: SITE_URL + "/welcome.html?specialties=" + encodeURIComponent(clientRefId),
      cancel_url: SITE_URL + "/#subscribe",
      allow_promotion_codes: true,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Could not create checkout session" }),
    };
  }
};


