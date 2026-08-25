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
const ABUHB_PRICE = "£15";   // Aneurin Bevan UHB cohort — matches any coupon whose id/name contains "ABUHB" (£5 off ONCE)
const APM_PRICE = "£15";     // APM member rate — matches any coupon whose id/name contains "APM" (£5 off FOREVER — recurring £15/yr)
const NASGP_PRICE = "£15";   // NASGP member rate — matches any coupon whose id/name contains "NASGP" (£5 off FOREVER — recurring £15/yr)
const SUPPORT_EMAIL = "info@mondayclinicalbrief.co.uk";
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

function buildWelcomeHtml(email, specialtySlug, trialStart, trialEnd, priceLine, customerName) {
  const specialtyName = getSpecialtyName(specialtySlug);
  const startStr = formatDate(trialStart);
  const endStr = formatDate(trialEnd);
  const provider = consumerProvider(email);
  const greetName = firstName(customerName);

  // Consumer addresses get the ask made properly and by name; everyone else
  // keeps the generic tip. Anything uncertain lands in the `else` branch.
  const emailTipBlock = provider
    ? `      <!-- Work-email suggestion (consumer address) -->
      <tr>
        <td style="padding:0 40px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border-left:4px solid #7a9bbf;">
            <tr>
              <td style="padding:20px 24px;">
                <p style="margin:0 0 10px;font-size:15px;color:#1a2e44;font-weight:bold;">One quick suggestion${greetName ? `, ${greetName}` : ""}</p>
                <p style="margin:0 0 10px;font-size:14px;color:#444;line-height:1.6;">
                  I noticed your subscription came through on a ${provider} address. If you were happy to use your work email, it's worth switching.
                </p>
                <p style="margin:0 0 10px;font-size:14px;color:#444;line-height:1.6;">
                  Each summary links straight to the original paper. Through your institutional access those links take you through to the full article rather than a paywall or abstract. That's where a lot of the value sits.
                </p>
                <p style="margin:0 0 10px;font-size:14px;color:#444;line-height:1.6;">
                  Switching takes ten seconds: just reply with your work address and I'll move your subscription across. Nothing else changes — same specialty, same Monday delivery. If you wanted to use both emails that's also fine.
                </p>
                <p style="margin:0;font-size:14px;color:#1a2e44;">— Tim</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
`
    : `      <!-- Institutional email tip -->
      <tr>
        <td style="padding:0 40px 20px;">
          <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
            <strong style="color:#1a2e44;">Tip:</strong> if you signed up with a personal address, just reply with your NHS or institutional email and we'll switch your subscription across — the journal links in each digest then open as full text through your institution's access. Same specialty, same Monday delivery.
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
                    <td style="padding:6px 0;font-size:14px;color:#1a2e44;font-weight:bold;">${priceLine} — cancel anytime</td>
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
                Every article has a <strong>"Log as CPD"</strong> button — one click records your reading in the free <a href="https://cpd.mondayclinicalbrief.co.uk" style="color:#005eb8;font-weight:bold;">MCB CPD Tracker</a>, with an AI-drafted reflection to personalise and export ready for appraisal.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#005eb8;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">3</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#444;line-height:1.5;">
                On <strong>${endStr}</strong> your 4-week free trial ends. If you haven't cancelled, your subscription will begin at <strong>${priceLine}</strong>.
              </td>
            </tr>
            <tr>
              <td style="vertical-align:top;padding:8px 0;width:28px;">
                <div style="width:22px;height:22px;background:#005eb8;border-radius:50%;text-align:center;line-height:22px;font-size:12px;color:#fff;font-weight:bold;">4</div>
              </td>
              <td style="vertical-align:top;padding:8px 0 8px 10px;font-size:14px;color:#444;line-height:1.5;">
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

async function sendWelcomeEmail(toEmail, specialtySlug, priceLine, customerName) {
  const trialStart = new Date();
  const trialEnd = new Date(trialStart);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);

  const specialtyName = getSpecialtyName(specialtySlug);
  const html = buildWelcomeHtml(toEmail, specialtySlug, trialStart, trialEnd, priceLine, customerName);

  // Plain-text alternative carries the same suggestion, same conditions.
  const provider = consumerProvider(toEmail);
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
    text: `Welcome to The Monday Clinical Brief!\n\nYou're subscribed to: ${specialtyName}\nTrial ends: ${formatDate(trialEnd)}\n\nYour first digest arrives next Monday morning.\n\nEvery article has a "Log as CPD" button — one click records your reading in the free MCB CPD Tracker (https://cpd.mondayclinicalbrief.co.uk), with an AI-drafted reflection to personalise and export ready for appraisal.${textTip}\n\nAfter your 4-week trial, your subscription begins at ${priceLine}. Cancel any time before ${formatDate(trialEnd)} at no cost.\n\nManage subscription: ${STRIPE_CUSTOMER_PORTAL}\n\nQuestions? ${SUPPORT_EMAIL}`,
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

  // Determine price — check for discount coupons first
  // FAF2026 coupon = £2 first year; ABUHB coupon = £15 first year; APM and NASGP coupons = £15/yr recurring; standard = £20/year
  let price = DEFAULT_PRICE;
  let couponKind = null; // "FAF2026" | "ABUHB" | "APM" | "NASGP" — drives the priceLine wording below
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
      price = "£2";
      couponKind = "FAF2026";
    } else if (norm.some(c => c.includes("ABUHB"))) {
      price = ABUHB_PRICE;
      couponKind = "ABUHB";
    } else if (norm.some(c => c.includes("APM"))) {
      price = APM_PRICE;
      couponKind = "APM";
    } else if (norm.some(c => c.includes("NASGP"))) {
      price = NASGP_PRICE;
      couponKind = "NASGP";
    } else if (session.amount_total && session.amount_total > 0) {
      price = formatPrice(session.amount_total);
    }
  } catch (e) {
    console.log("Could not parse discounts, using default price:", e.message);
  }

  // For multi-specialty signups, calculate total price if not discounted
  if (specialtySlugs.length > 1 && price === DEFAULT_PRICE) {
    const totalPounds = 20 + ((specialtySlugs.length - 1) * 5);
    price = `£${totalPounds}`;
  }

  // Build the human price phrase for the email. FAF2026 and ABUHB are one-time
  // (first year only), so spell out the renewal. The APM coupon is duration:forever,
  // so the £15 genuinely recurs — say so, and never imply a £20 renewal.
  let priceLine;
  if (couponKind === "FAF2026") {
    priceLine = `£2 for the first year, then ${DEFAULT_PRICE}/year`;
  } else if (couponKind === "ABUHB") {
    priceLine = `${ABUHB_PRICE} for the first year, then ${DEFAULT_PRICE}/year`;
  } else if (couponKind === "APM") {
    priceLine = `${APM_PRICE}/year — your APM member rate`;
  } else if (couponKind === "NASGP") {
    priceLine = `${NASGP_PRICE}/year — your NASGP member rate`;
  } else {
    priceLine = `${price}/year`;
  }

  try {
    await sendWelcomeEmail(email, specialtySlug, priceLine, customerName);
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
