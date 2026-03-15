// netlify/functions/stripe-webhook.js
//
// Listens for Stripe checkout.session.completed events and automatically
// sends a welcome email to new subscribers.
//
// Setup:
//   1. Copy this file to netlify/functions/stripe-webhook.js in your site repo
//   2. Add a netlify.toml if you don't have one (see bottom of file)
//   3. Set these environment variables in Netlify dashboard → Site settings → Environment variables:
//        STRIPE_WEBHOOK_SECRET   (from Stripe dashboard → Webhooks → your endpoint → Signing secret)
//        GMAIL_USER              mondayclinicalbrief@gmail.com
//        GMAIL_APP_PASSWORD      your 16-char app password
//   4. Deploy the site — Netlify will expose this function at:
//        https://mondayclinicalbrief.co.uk/.netlify/functions/stripe-webhook
//   5. In Stripe dashboard → Developers → Webhooks → Add endpoint:
//        URL: https://mondayclinicalbrief.co.uk/.netlify/functions/stripe-webhook
//        Events: checkout.session.completed

const nodemailer = require("nodemailer");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// ── Config ────────────────────────────────────────────────────────────────────

const TRIAL_DAYS = 28;
const DEFAULT_PRICE = "£20";
const SUPPORT_EMAIL = "mondayclinicalbrief@gmail.com";
const STRIPE_CUSTOMER_PORTAL = "https://billing.stripe.com/p/login/dRm28k4rI5LYaoh3qaefC00";

// Map specialty slugs to display names
const SPECIALTY_NAMES = {
  "acute-medicine": "Acute Medicine",
  "anaesthetics": "Anaesthetics",
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatPrice(amountTotal) {
  // amountTotal is in pence e.g. 200 = £2, 2000 = £20
  // Stripe reports 0 for free trials — fall back to default price
  if (!amountTotal || amountTotal === 0) return DEFAULT_PRICE;
  const pounds = amountTotal / 100;
  return `£${pounds % 1 === 0 ? pounds.toFixed(0) : pounds.toFixed(2)}`;
}

function getSpecialtyName(slug) {
  return SPECIALTY_NAMES[slug] || slug.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

// ── Email HTML ─────────────────────────────────────────────────────────────────

function buildWelcomeHtml(email, specialtySlug, trialStart, trialEnd, price) {
  const specialtyName = getSpecialtyName(specialtySlug);
  const startStr = formatDate(trialStart);
  const endStr = formatDate(trialEnd);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to The Monday Clinical Brief</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f0;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f0;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

      <!-- Header -->
      <tr>
        <td style="background:#1a2e44;padding:32px 40px;text-align:center;">
          <p style="margin:0;font-size:11px;letter-spacing:3px;color:#7a9bbf;text-transform:uppercase;">The</p>
          <h1 style="margin:4px 0 0;font-size:26px;color:#ffffff;font-weight:normal;letter-spacing:1px;">Monday Clinical Brief</h1>
          <p style="margin:8px 0 0;font-size:13px;color:#7a9bbf;">Weekly journal digests for busy clinicians</p>
        </td>
      </tr>

      <!-- Tick + Headline -->
      <tr>
        <td style="padding:40px 40px 20px;text-align:center;">
          <div style="width:56px;height:56px;background:#eef4ee;border-radius:50%;margin:0 auto 20px;line-height:56px;font-size:26px;">✓</div>
          <h2 style="margin:0 0 12px;font-size:22px;color:#1a2e44;font-weight:normal;">Your free trial has started</h2>
          <p style="margin:0;font-size:15px;color:#555;line-height:1.6;">
            Welcome aboard. You're now subscribed to the <strong>${specialtyName}</strong> digest.
            Your first issue will arrive next Monday morning.
          </p>
        </td>
      </tr>

      <!-- Trial details box -->
      <tr>
        <td style="padding:20px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border-radius:6px;border-left:4px solid #005eb8;">
            <tr>
              <td style="padding:24px;">
                <p style="margin:0 0 12px;font-size:13px;font-weight:bold;color:#1a2e44;text-transform:uppercase;letter-spacing:1px;">Your trial details</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#555;width:50%;">Trial started</td>
                    <td style="padding:6px 0;font-size:14px;color:#1a2e44;font-weight:bold;">${startStr}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#555;">Trial ends</td>
                    <td style="padding:6px 0;font-size:14px;color:#1a2e44;font-weight:bold;">${endStr}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#555;">Specialty</td>
                    <td style="padding:6px 0;font-size:14px;color:#1a2e44;font-weight:bold;">${specialtyName}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#555;">After trial</td>
                    <td style="padding:6px 0;font-size:14px;color:#1a2e44;font-weight:bold;">${price}/year — cancel anytime</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- What happens next -->
      <tr>
        <td style="padding:10px 40px 20px;">
          <p style="margin:0 0 16px;font-size:15px;font-weight:bold;color:#1a2e44;">What happens next</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#005eb8;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">1</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#444;line-height:1.5;">
                Every <strong>Monday morning</strong> you'll receive a digest of the latest peer-reviewed research in ${specialtyName}, summarised by AI and reviewed for clinical relevance.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#005eb8;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">2</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#444;line-height:1.5;">
                On <strong>${endStr}</strong> your 4-week free trial ends. If you haven't cancelled, your annual subscription of <strong>${price}</strong> will begin.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#005eb8;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">3</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#444;line-height:1.5;">
                You can <strong>cancel at any time</strong> before ${endStr} at no cost. No payment is taken during the trial.
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Cancel CTA -->
      <tr>
        <td style="padding:10px 40px 30px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8f0;border-radius:6px;border:1px solid #ffe0b2;">
            <tr>
              <td style="padding:20px 24px;">
                <p style="margin:0 0 8px;font-size:14px;color:#1a2e44;font-weight:bold;">Want to cancel?</p>
                <p style="margin:0 0 14px;font-size:13px;color:#666;line-height:1.5;">
                  Cancel before <strong>${endStr}</strong> and you won't be charged a penny.
                </p>
                <a href="${STRIPE_CUSTOMER_PORTAL}"
                   style="display:inline-block;background:#1a2e44;color:#ffffff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:bold;">
                  Manage Subscription →
                </a>
                <p style="margin:12px 0 0;font-size:12px;color:#999;">
                  Or simply reply to this email and we'll cancel for you.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f8f9fb;padding:24px 40px;border-top:1px solid #eee;text-align:center;">
          <p style="margin:0 0 6px;font-size:13px;color:#888;">
            Questions? Reply to this email or contact
            <a href="mailto:${SUPPORT_EMAIL}" style="color:#005eb8;">${SUPPORT_EMAIL}</a>
          </p>
          <p style="margin:0;font-size:11px;color:#aaa;">
            The Monday Clinical Brief · AI-assisted summaries are for information only and are not a substitute for reading original articles or clinical judgement.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Send welcome email ─────────────────────────────────────────────────────────

async function sendWelcomeEmail(toEmail, specialtySlug, price) {
  const trialStart = new Date();
  const trialEnd = new Date(trialStart);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

  const specialtyName = getSpecialtyName(specialtySlug);
  const html = buildWelcomeHtml(toEmail, specialtySlug, trialStart, trialEnd, price);

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"The Monday Clinical Brief" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Welcome to The Monday Clinical Brief — your free trial has started",
    text: `Welcome to The Monday Clinical Brief!\n\nYou're subscribed to: ${specialtyName}\nTrial ends: ${formatDate(trialEnd)}\n\nYour first digest arrives next Monday morning.\n\nAfter your 4-week trial, your annual subscription of ${price} begins automatically. Cancel any time before ${formatDate(trialEnd)} at no cost.\n\nManage subscription: ${STRIPE_CUSTOMER_PORTAL}\n\nQuestions? ${SUPPORT_EMAIL}`,
    html,
  });

  console.log(`✓ Welcome email sent to ${toEmail} (${specialtyName}, ${price})`);
}

// ── Netlify handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Verify Stripe webhook signature
  const sig = event.headers["stripe-signature"];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Only handle checkout.session.completed
  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: "Event ignored" };
  }

  const session = stripeEvent.data.object;

  // Extract email
  const email = session.customer_details?.email || session.customer_email;
  if (!email) {
    console.error("No email found in session:", session.id);
    return { statusCode: 200, body: "No email — skipped" };
  }

  // Extract specialty slug from client_reference_id
  // client_reference_id format: "cardiology" or "extra-cardiology"
  const ref = session.client_reference_id || "";
  const specialtySlug = ref.startsWith("extra-") ? ref.replace("extra-", "") : ref;

  if (!specialtySlug) {
    console.error("No specialty slug in client_reference_id:", ref);
    return { statusCode: 200, body: "No specialty — skipped" };
  }

  // Determine price — check for discount coupons first
  // FAF2026 coupon = £2 first year; standard trial = £20/year
  let price = DEFAULT_PRICE;
  try {
    const discounts = session.total_details?.breakdown?.discounts || [];
    const couponCodes = discounts.map(d => d.discount?.coupon?.id || d.discount?.coupon?.name || "").filter(Boolean);
    console.log("Coupon codes detected:", couponCodes);
    if (couponCodes.some(c => c.toUpperCase().includes("FAF2026"))) {
      price = "£2";
    } else if (session.amount_total && session.amount_total > 0) {
      price = formatPrice(session.amount_total);
    }
  } catch (e) {
    console.log("Could not parse discounts, using default price");
  }

  try {
    await sendWelcomeEmail(email, specialtySlug, price);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, email, specialtySlug, price }),
    };
  } catch (err) {
    console.error("Failed to send welcome email:", err);
    return { statusCode: 500, body: `Email error: ${err.message}` };
  }
};

// ── netlify.toml (add this to your site root if you don't have one) ────────────
//
// [functions]
//   directory = "netlify/functions"
//
// [[redirects]]
//   from = "/*"
//   to = "/index.html"
//   status = 200
