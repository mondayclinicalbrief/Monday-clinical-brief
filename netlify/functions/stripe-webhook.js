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
//        GMAIL_USER              info@mondayclinicalbrief.co.uk (Workspace account —
//                                keeps From/SPF/DKIM aligned with the domain's DMARC)
//        GMAIL_APP_PASSWORD      a 16-char app password for that Workspace account
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
const PRIMARY_PRICE_GBP = 20;      // primary specialty
const EXTRA_SPECIALTY_GBP = 5;     // each additional specialty

// Member-rate coupons all take a flat £5 off the whole order — so a member with
// two specialties pays £20, not a flat £15. Matched on the coupon id/name, so the
// Stripe coupon ID must contain the code; the promotion code string is not visible here.
//   ABUHB — duration: ONCE    (first year only, then full list price)
//   APM   — duration: FOREVER (the discounted rate recurs)
//   NASGP — duration: FOREVER (the discounted rate recurs)
//   SAM   — duration: FOREVER (the discounted rate recurs)
//   MDDUS — duration: FOREVER (the discounted rate recurs)
const MEMBER_RATE_DISCOUNT_GBP = 5;
const MEMBER_RATE_COUPONS = ["ABUHB", "APM", "NASGP", "SAM", "MDDUS"];
const RECURRING_MEMBER_RATES = ["APM", "NASGP", "SAM", "MDDUS"];
const SUPPORT_EMAIL = "info@mondayclinicalbrief.co.uk";
const STRIPE_CUSTOMER_PORTAL = "https://billing.stripe.com/p/login/dRm28k4rI5LYaoh3qaefC00";

// Map specialty slugs to display names
const SPECIALTY_NAMES = {
  "acute-medicine": "Acute Medicine",
  "anaesthetics": "Anaesthetics",
  "cardiology": "Cardiology",
  "cardiothoracic-surgery": "Cardiothoracic Surgery",
  "dental-hygiene-therapy": "Dental Hygiene & Therapy",
  "dentistry": "Dentistry",
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
  "oral-surgery": "Oral & Maxillofacial Surgery",
  "orthodontics": "Orthodontics",
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

// Multi-specialty subscribers pay for every specialty they picked, so the welcome
// email names all of them — listing only the primary left the rest unconfirmed.
// "A and B"; "A, B and C" — Oxford comma omitted to match the house style.
function listSpecialtyNames(slugs) {
  const names = (slugs || []).filter(Boolean).map(getSpecialtyName);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Consumer mailbox providers, mapped to the name we use in the note.
//
// Deliberately a blocklist of known consumer providers rather than an
// allowlist of NHS/institutional domains: subscribers receive at plenty of
// legitimate non-NHS institutional addresses (mariecurie.org.uk,
// sthelena.org.uk, health.nsw.gov.au, sfh.ie, aphp.fr), and an allowlist
// would wrongly nudge every one of them. Anything not listed here falls
// through to the generic tip — i.e. to today's behaviour.
const CONSUMER_PROVIDERS = {
  "gmail.com": "Gmail",
  "googlemail.com": "Gmail",
  "yahoo.com": "Yahoo",
  "yahoo.co.uk": "Yahoo",
  "yahoo.ie": "Yahoo",
  "ymail.com": "Yahoo",
  "y7mail.com": "Yahoo",
  "rocketmail.com": "Yahoo",
  "hotmail.com": "Hotmail",
  "hotmail.co.uk": "Hotmail",
  "live.com": "Outlook",
  "live.co.uk": "Outlook",
  "outlook.com": "Outlook",
  "outlook.co.uk": "Outlook",
  "msn.com": "Outlook",
  "icloud.com": "iCloud",
  "me.com": "iCloud",
  "mac.com": "iCloud",
  "aol.com": "AOL",
  "btinternet.com": "BT",
  "sky.com": "Sky",
  "virginmedia.com": "Virgin Media",
  "talktalk.net": "TalkTalk",
  "ntlworld.com": "NTL",
  "blueyonder.co.uk": "Blueyonder",
  "tiscali.co.uk": "Tiscali",
  "protonmail.com": "Proton",
  "proton.me": "Proton",
  "gmx.com": "GMX",
  "gmx.co.uk": "GMX",
  "mail.com": "Mail.com",
};

// Dental panels. Dentists are largely practice-based and often self-employed,
// with no institutional journal access and frequently no NHS mailbox — so the
// "use your NHS or institutional email" prompt is unhelpful to them and signals
// the product was built for hospital doctors. Suppressed for dental-only orders.
// A MIXED order (e.g. oral-surgery + general-surgery, a dual-qualified OMFS
// clinician) still gets the prompt, because that reader probably does have
// hospital access.
// Canonical list: backend/journals.yaml. Mirrored here, in the other
// Netlify function, and in welcome.html — keep the four in step.
const DENTAL_SLUGS = new Set([
  "dentistry",
  "oral-surgery",
  "orthodontics",
  "dental-hygiene-therapy",
]);

// True only when EVERY slug in the order is dental.
function isDentalOnly(slugs) {
  const list = Array.isArray(slugs) ? slugs : [slugs];
  return list.length > 0 && list.every((s) => DENTAL_SLUGS.has(s));
}

// Returns the friendly provider name for a known consumer address, else null.
// Anything malformed, missing, or unrecognised returns null so the caller
// falls back to the generic tip.
function consumerProvider(email) {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return CONSUMER_PROVIDERS[domain] || null;
}

// Stripe populates customer_details.name for card payments, but it isn't
// guaranteed — the greeting drops the name rather than rendering an empty gap.
// Cardholder names in this audience often carry a title ("Dr Sam Reed"), which
// would otherwise greet them as "Dr", so leading titles are skipped.
const NAME_TITLES = new Set([
  "dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "miss",
  "prof", "prof.", "professor", "sir", "dame", "mx", "mx.",
]);

function firstName(name) {
  if (typeof name !== "string") return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && NAME_TITLES.has(parts[0].toLowerCase())) parts.shift();
  const first = parts[0];
  return first && /^[\p{L}][\p{L}'-]*$/u.test(first) ? first : null;
}

// ── Email HTML ─────────────────────────────────────────────────────────────────

function buildWelcomeHtml(email, specialtySlugs, trialStart, trialEnd, priceLine, customerName) {
  const slugs = Array.isArray(specialtySlugs) ? specialtySlugs : [specialtySlugs];
  const specialtyName = listSpecialtyNames(slugs);
  const multi = slugs.length > 1;
  const digestWord = multi ? "digests" : "digest";
  const issueLine = multi ? "Your first issues will arrive" : "Your first issue will arrive";
  const specialtyLabel = multi ? "Specialties" : "Specialty";
  const researchLine = multi
    ? `a separate digest for each of your specialties — ${specialtyName} — covering the latest peer-reviewed research`
    : `a digest of the latest peer-reviewed research in ${specialtyName}`;
  const startStr = formatDate(trialStart);
  const endStr = formatDate(trialEnd);
  const provider = isDentalOnly(slugs) ? null : consumerProvider(email);
  const greetName = firstName(customerName);

  // Consumer addresses get the ask made properly and by name; everyone else
  // keeps the generic tip. Anything uncertain lands in the `else` branch.
  const emailTipBlock = provider
    ? `      <!-- Work-email suggestion (consumer address) -->
      <tr>
        <td style="padding:0 40px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcf9;border:1px solid #e2dfd8;border-radius:8px;">
            <tr>
              <td style="padding:20px 24px;">
                <p style="margin:0 0 10px;font-size:15px;color:#1c1c1c;font-weight:bold;">One quick suggestion${greetName ? `, ${greetName}` : ""}</p>
                <p style="margin:0 0 10px;font-size:14px;color:#5f5f5b;line-height:1.6;">
                  I noticed your subscription came through on a ${provider} address. If you were happy to use your work email, it's worth switching.
                </p>
                <p style="margin:0 0 10px;font-size:14px;color:#5f5f5b;line-height:1.6;">
                  Each summary links straight to the original paper. Through your institutional access those links take you through to the full article rather than a paywall or abstract. That's where a lot of the value sits.
                </p>
                <p style="margin:0 0 10px;font-size:14px;color:#5f5f5b;line-height:1.6;">
                  Switching takes ten seconds: just reply with your work address and I'll move your subscription across. Nothing else changes — same specialty, same Monday delivery. If you wanted to use both emails that's also fine.
                </p>
                <p style="margin:0;font-size:14px;color:#1c1c1c;">— Tim</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
`
    : `      <!-- Institutional email tip -->
      <tr>
        <td style="padding:0 40px 20px;">
          <p style="margin:0;font-size:13px;color:#6e6e66;line-height:1.6;">
            <strong style="color:#1c1c1c;">Tip:</strong> if you signed up with a personal address, just reply with your NHS or institutional email and we'll switch your subscription across — the journal links in each digest then open as full text through your institution's access. Same specialty, same Monday delivery.
          </p>
        </td>
      </tr>
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to The Monday Clinical Brief</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&amp;family=Figtree:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#e9e4da;font-family:'Figtree', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e9e4da;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#f4f1e9;border:1px solid #e2dfd8;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">

      <!-- Header -->
      <tr>
        <td align="center" style="background:#f4f1e9;padding:26px 32px 22px;border-bottom:1px solid #e2dfd8;">
          <!-- The full lockup, not a mark plus HTML text: Instrument Serif is stripped by
               Outlook and several Gmail clients, so a text wordmark renders in Georgia for a
               large share of recipients. Must stay the TRANSPARENT export — the brand-kit
               "light" lockups are flattened onto opaque #f7f5f0 and seam against this cream. -->
          <img src="https://mondayclinicalbrief.co.uk/assets/brand/mcb-lockup-email.png"
               width="536" height="207" alt="The Monday Clinical Brief"
               style="display:block;width:536px;max-width:100%;height:auto;border:0;margin:0 auto;font-family:'Instrument Serif', Georgia, serif;font-size:26px;color:#1c1c1c;">
        </td>
      </tr>

      <!-- Tick + Headline -->
      <tr>
        <td style="padding:40px 40px 20px;text-align:center;">
          <div style="width:56px;height:56px;background:#5a7a6a;border-radius:50%;margin:0 auto 20px;line-height:56px;font-size:26px;color:#ffffff;">✓</div>
          <h2 style="margin:0 0 12px;font-family:'Instrument Serif', Georgia, 'Times New Roman', serif;font-size:26px;color:#b8873a;font-weight:400;letter-spacing:-0.01em;">Your free trial has started</h2>
          <p style="margin:0;font-size:15px;color:#5f5f5b;line-height:1.6;">
            Welcome aboard. You're now subscribed to the <strong>${specialtyName}</strong> ${digestWord}.
            ${issueLine} next Monday morning.
          </p>
        </td>
      </tr>

      <!-- Trial details box -->
      <tr>
        <td style="padding:20px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcf9;border:1px solid #5a7a6a;border-radius:8px;">
            <tr>
              <td style="padding:24px;">
                <p style="margin:0 0 14px;"><span style="display:inline-block;background:#5a7a6a;color:#ffffff;padding:5px 12px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">Your trial details</span></p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#5f5f5b;width:50%;">Trial started</td>
                    <td style="padding:6px 0;font-size:14px;color:#1c1c1c;font-weight:bold;">${startStr}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#5f5f5b;">Trial ends</td>
                    <td style="padding:6px 0;font-size:14px;color:#1c1c1c;font-weight:bold;">${endStr}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#5f5f5b;">${specialtyLabel}</td>
                    <td style="padding:6px 0;font-size:14px;color:#1c1c1c;font-weight:bold;">${specialtyName}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;font-size:14px;color:#5f5f5b;">After trial</td>
                    <td style="padding:6px 0;font-size:14px;color:#1c1c1c;font-weight:bold;">${priceLine} — cancel anytime</td>
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
          <p style="margin:0 0 16px;font-size:15px;font-weight:bold;color:#1c1c1c;">What happens next</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#5a7a6a;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">1</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#5f5f5b;line-height:1.5;">
                Every <strong>Monday morning</strong> you'll receive ${researchLine}, summarised by AI and reviewed for clinical relevance.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#5a7a6a;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">2</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#5f5f5b;line-height:1.5;">
                Every article has a <strong>"Log as CPD"</strong> button — one click records your reading in the free <a href="https://cpd.mondayclinicalbrief.co.uk" style="color:#3d5a4c;font-weight:bold;">MCB CPD Tracker</a>, with an AI-drafted reflection to personalise and export ready for appraisal.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#5a7a6a;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">3</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#5f5f5b;line-height:1.5;">
                On <strong>${endStr}</strong> your 4-week free trial ends. If you haven't cancelled, your subscription will begin at <strong>${priceLine}</strong>.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#5a7a6a;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">4</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#5f5f5b;line-height:1.5;">
                You can <strong>cancel at any time</strong> before ${endStr} at no cost. No payment is taken during the trial.
              </td>
            </tr>
          </table>
        </td>
      </tr>

${emailTipBlock}
      <!-- Cancel CTA -->
      <tr>
        <td style="padding:10px 40px 30px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdfcf9;border:1px solid #e2dfd8;border-radius:8px;">
            <tr>
              <td style="padding:20px 24px;">
                <p style="margin:0 0 8px;font-size:14px;color:#1c1c1c;font-weight:bold;">Want to cancel?</p>
                <p style="margin:0 0 14px;font-size:13px;color:#6e6e66;line-height:1.5;">
                  Cancel before <strong>${endStr}</strong> and you won't be charged a penny.
                </p>
                <div style="text-align:center;">
                  <a href="${STRIPE_CUSTOMER_PORTAL}"
                     style="display:inline-block;background:#5a7a6a;color:#ffffff;padding:10px 22px;border-radius:40px;text-decoration:none;font-size:13px;font-weight:bold;">
                    Manage Subscription
                  </a>
                </div>
                <p style="margin:12px 0 0;font-size:12px;color:#6e6e66;text-align:center;">
                  Or simply reply to this email and we'll cancel for you.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#fdfcf9;padding:24px 40px;border-top:1px solid #e2dfd8;text-align:center;">
          <p style="margin:0 0 6px;font-size:13px;color:#6e6e66;">
            Questions? Reply to this email or contact
            <a href="mailto:${SUPPORT_EMAIL}" style="color:#3d5a4c;">${SUPPORT_EMAIL}</a>
          </p>
          <p style="margin:0;font-size:11px;color:#6e6e66;">
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

async function sendWelcomeEmail(toEmail, specialtySlugs, priceLine, customerName) {
  const trialStart = new Date();
  const trialEnd = new Date(trialStart);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

  const slugs = Array.isArray(specialtySlugs) ? specialtySlugs : [specialtySlugs];
  const specialtyName = listSpecialtyNames(slugs);
  const multi = slugs.length > 1;
  const html = buildWelcomeHtml(toEmail, slugs, trialStart, trialEnd, priceLine, customerName);

  // Plain-text alternative carries the same suggestion, same conditions.
  const provider = isDentalOnly(slugs) ? null : consumerProvider(toEmail);
  const greetName = firstName(customerName);
  const textTip = provider
    ? `\n\nOne quick suggestion${greetName ? `, ${greetName}` : ""} — I noticed your subscription came through on a ${provider} address. If you were happy to use your work email, it's worth switching. Each summary links straight to the original paper, and through your institutional access those links take you through to the full article rather than a paywall or abstract. That's where a lot of the value sits.\n\nSwitching takes ten seconds: just reply with your work address and I'll move your subscription across. Nothing else changes — same specialty, same Monday delivery. If you wanted to use both emails that's also fine.\n\n— Tim`
    : "";

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
    text: `Welcome to The Monday Clinical Brief!\n\nYou're subscribed to: ${specialtyName}\nTrial ends: ${formatDate(trialEnd)}\n\n${multi ? "Your first digests arrive" : "Your first digest arrives"} next Monday morning.\n\nEvery article has a "Log as CPD" button — one click records your reading in the free MCB CPD Tracker (https://cpd.mondayclinicalbrief.co.uk), with an AI-drafted reflection to personalise and export ready for appraisal.${textTip}\n\nAfter your 4-week trial, your subscription begins at ${priceLine}. Cancel any time before ${formatDate(trialEnd)} at no cost.\n\nManage subscription: ${STRIPE_CUSTOMER_PORTAL}\n\nQuestions? ${SUPPORT_EMAIL}`,
    html,
  });

  console.log(`✓ Welcome email sent to ${toEmail} (${specialtyName}, ${priceLine})`);
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
  const customerName = session.customer_details?.name || null;
  if (!email) {
    console.error("No email found in session:", session.id);
    return { statusCode: 200, body: "No email — skipped" };
  }

  // Extract specialty slug(s) from client_reference_id
  // Formats: "cardiology", "extra-cardiology", or "cardiology,neurology,palliative-care"
  const ref = session.client_reference_id || "";
  let specialtySlugs;
  if (ref.includes(",")) {
    // Multi-specialty signup: comma-separated list (primary first)
    specialtySlugs = ref.split(",").map(s => s.trim()).filter(Boolean);
  } else {
    const slug = ref.startsWith("extra-") ? ref.replace("extra-", "") : ref;
    specialtySlugs = slug ? [slug] : [];
  }
  const specialtySlug = specialtySlugs[0] || "";

  if (!specialtySlug) {
    console.error("No specialty slug in client_reference_id:", ref);
    return { statusCode: 200, body: "No specialty — skipped" };
  }

  // Determine price. The list price is £20 for the primary specialty plus £5 for
  // each additional one; a member-rate coupon takes £5 off that total. Deriving both
  // from the specialty count keeps multi-specialty signups correct — quoting a flat
  // £15 to someone buying two specialties would understate what they actually pay.
  const listTotalGbp = PRIMARY_PRICE_GBP + Math.max(0, specialtySlugs.length - 1) * EXTRA_SPECIALTY_GBP;
  let price = `£${listTotalGbp}`;
  let couponKind = null; // "FAF2026" | "ABUHB" | "APM" | "NASGP" | "SAM" — drives the priceLine wording below
  try {
    // 1. Check session.discount (included in webhook payload)
    const couponCodes = [];
    if (session.discount?.coupon) {
      const c = session.discount.coupon;
      if (c.id) couponCodes.push(c.id);
      if (c.name) couponCodes.push(c.name);
    }

    // 2. Also check total_details.breakdown.discounts (may be present if expanded)
    const discounts = session.total_details?.breakdown?.discounts || [];
    for (const d of discounts) {
      const id = d.discount?.coupon?.id || d.discount?.coupon?.name || "";
      if (id) couponCodes.push(id);
    }

    // 3. If still empty, retrieve the session from Stripe with expanded fields
    if (couponCodes.length === 0) {
      try {
        const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ["total_details.breakdown", "discounts"],
        });
        if (fullSession.discount?.coupon) {
          const c = fullSession.discount.coupon;
          if (c.id) couponCodes.push(c.id);
          if (c.name) couponCodes.push(c.name);
        }
        const expandedDiscounts = fullSession.total_details?.breakdown?.discounts || [];
        for (const d of expandedDiscounts) {
          const id = d.discount?.coupon?.id || d.discount?.coupon?.name || "";
          if (id) couponCodes.push(id);
        }
      } catch (retrieveErr) {
        console.log("Could not retrieve expanded session:", retrieveErr.message);
      }
    }

    // 4. A coupon attached to a Payment Link / the subscription itself does NOT
    //    appear on the checkout session — pull it from the subscription. This is
    //    the path ABUHB Payment Link signups take.
    if (couponCodes.length === 0 && session.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(session.subscription, {
          expand: ["discounts"],
        });
        const subDiscounts = sub.discounts || (sub.discount ? [sub.discount] : []);
        for (const d of subDiscounts) {
          const c = (d && typeof d === "object") ? d.coupon : null;
          if (c?.id) couponCodes.push(c.id);
          if (c?.name) couponCodes.push(c.name);
        }
      } catch (subErr) {
        console.log("Could not retrieve subscription discounts:", subErr.message);
      }
    }

    console.log("Coupon codes detected:", couponCodes);
    const norm = couponCodes.map(c => String(c).toUpperCase());
    if (norm.some(c => c.includes("FAF2026"))) {
      couponKind = "FAF2026";
    } else if (norm.some(c => c.includes("ABUHB"))) {
      couponKind = "ABUHB";
    } else if (norm.some(c => c.includes("APM"))) {
      couponKind = "APM";
    } else if (norm.some(c => c.includes("NASGP"))) {
      couponKind = "NASGP";
    } else if (norm.some(c => c.includes("SAM"))) {
      couponKind = "SAM";
    }

    // Stripe reports amount_total of 0 for the whole 28-day trial, so it is only
    // trustworthy once it is actually populated. Otherwise derive the figure.
    if (session.amount_total && session.amount_total > 0) {
      price = formatPrice(session.amount_total);
    } else if (couponKind === "FAF2026") {
      // Flat first-year promo price, independent of the specialty count.
      price = "£2";
    } else if (MEMBER_RATE_COUPONS.includes(couponKind)) {
      price = `£${listTotalGbp - MEMBER_RATE_DISCOUNT_GBP}`;
    }
  } catch (e) {
    console.log("Could not parse discounts, using list price:", e.message);
  }

  // Build the human price phrase for the email. FAF2026 and ABUHB apply to the first
  // year only, so spell out the renewal at the full list price. APM and NASGP are
  // duration:forever, so their rate genuinely recurs — say so, and never imply that
  // the member reverts to list price.
  let priceLine;
  if (couponKind === "FAF2026" || couponKind === "ABUHB") {
    priceLine = `${price} for the first year, then £${listTotalGbp}/year`;
  } else if (RECURRING_MEMBER_RATES.includes(couponKind)) {
    priceLine = `${price}/year — your ${couponKind} member rate`;
  } else {
    priceLine = `${price}/year`;
  }

  try {
    await sendWelcomeEmail(email, specialtySlugs, priceLine, customerName);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, email, specialties: specialtySlugs, price }),
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
