// netlify/functions/licence-signup.js
//
// Sign-up for staff covered by an organisation licence. Their employer has
// already paid, so there is no Stripe checkout: the page at /hospice-education/
// POSTs here, and a valid submission is written to the Supabase
// `licence_signups` table with status "pending".
//
// Nothing here adds anyone to the send list. Tim approves pending rows with
// backend/licence_signups.py, which is what puts people into subscribers.json
// and sends the welcome email.
//
// The email-domain allowlist below is the real gate. The page does no domain
// checking of its own — it just shows whatever error this function returns —
// so the list lives in exactly one place.
//
// Required env vars (already set for unsubscribe.js):
//   SUPABASE_URL                e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   bypasses RLS for the insert
//
// Expects POST body:
//   { licence: "hospice-education", name: "…", email: "…",
//     specialties: ["palliative-care", …], website: "" }
// `website` is a honeypot: real people never see or fill it.

const crypto = require("crypto");
const SPECIALTIES = require("../../_data/specialties.json");

// ── Config ───────────────────────────────────────────────────────────────────

const SUPPORT_EMAIL = "info@mondayclinicalbrief.co.uk";

// One entry per organisation licence. `domains` matches the part of the email
// after the @, exactly or as a parent domain (so "sthelena.org.uk" also allows
// "mail.sthelena.org.uk").
//
// hospice-education: the three hospice domains were confirmed by Leanne Willis
// (Synergy lead) on 21 Oct 2026. hospiceeducation.org.uk is the shared
// Hospice Education team's own domain (Mandy Summons, Leanne Willis); it was
// not on Leanne's list but they are covered staff. Phasing (St Helena first)
// happens at approval, not here: approve one domain at a time with
// `licence_signups.py --domain sthelena.org.uk`.
const LICENCES = {
  "hospice-education": {
    name: "Farleigh, St Elizabeth and St Helena Hospices",
    domains: [
      "sthelena.org.uk",
      "stelizabethhospice.org.uk",
      "hospiceeducation.org.uk",
      "farleighhospice.org",
    ],
  },
};

// Dentistry is a separate product line and is not part of a medical licence.
const ALLOWED_SLUGS = new Set(
  SPECIALTIES.filter((s) => !s.dental).map((s) => s.slug)
);

const EMAIL_RE = /^[^\s@<>"',;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// ── Helpers ──────────────────────────────────────────────────────────────────

function domainAllowed(email, domains) {
  const domain = email.split("@").pop();
  return domains.some((d) => domain === d || domain.endsWith("." + d));
}

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  // Strip control characters and angle brackets, collapse whitespace.
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

async function insertSignup(row) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/licence_signups`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${detail}`);
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const reply = (statusCode, payload) => ({
    statusCode,
    headers,
    body: JSON.stringify(payload),
  });

  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Method not allowed. Use POST." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return reply(400, { error: "We could not read that request. Please try again." });
  }

  // Honeypot: report success so a bot learns nothing, but store nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return reply(200, { status: "ok" });
  }

  const licence = LICENCES[body.licence];
  if (!licence) {
    return reply(400, { error: "This sign-up link is not valid. Please use the link your organisation gave you." });
  }

  const name = cleanName(body.name);
  if (name.length < 2 || name.length > 100) {
    return reply(400, { error: "Please enter your name." });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return reply(400, { error: "Please enter a valid email address." });
  }
  if (!domainAllowed(email, licence.domains)) {
    return reply(403, {
      error:
        `Please use your work email address. This sign-up is for staff at ${licence.name}. ` +
        `If your work address is not accepted, email ${SUPPORT_EMAIL} and we will sort it out.`,
    });
  }

  const specialties = Array.isArray(body.specialties)
    ? [...new Set(body.specialties.filter((s) => typeof s === "string"))]
    : [];
  if (specialties.length === 0) {
    return reply(400, { error: "Please choose at least one specialty." });
  }
  if (!specialties.every((s) => ALLOWED_SLUGS.has(s))) {
    return reply(400, { error: "One of the specialties was not recognised. Please reload the page and try again." });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Supabase env vars not configured");
    return reply(500, { error: `Something went wrong on our side. Please email ${SUPPORT_EMAIL} and we will sign you up by hand.` });
  }

  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    null;

  try {
    await insertSignup({
      licence: body.licence,
      name,
      email,
      specialties,
      user_agent: (event.headers["user-agent"] || "").slice(0, 200) || null,
      ip_hash: hashIp(ip),
    });
  } catch (err) {
    console.error("Licence sign-up insert failed:", err.message);
    return reply(500, { error: `We could not record your sign-up. Please email ${SUPPORT_EMAIL} and we will sign you up by hand.` });
  }

  return reply(200, { status: "ok" });
};
