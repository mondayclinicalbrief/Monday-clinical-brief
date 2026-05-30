// netlify/functions/unsubscribe.js
//
// Handles unsubscribe requests from two sources:
//   1. Mailbox providers (Gmail / Outlook) hitting the List-Unsubscribe-Post
//      URL — they POST with no body, expecting a 200.
//   2. The visible "Unsubscribe" link in the email body, which lands on
//      /unsubscribe.html. That page JS-POSTs here after the user confirms.
//
// Token format: base64url(email|slug).base64url(hmac_sha256(secret, email|slug))
// The same secret (MCB_UNSUB_SECRET) is shared with the Python backend that
// generates tokens at send time.
//
// Required env vars:
//   MCB_UNSUB_SECRET            HMAC secret, shared with backend
//   SUPABASE_URL                e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   bypasses RLS for the insert

const crypto = require("crypto");

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}

function verifyToken(token, secret) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sigB64] = token.split(".", 2);
  let payload;
  try {
    payload = b64urlDecode(payloadB64);
  } catch (_) {
    return null;
  }
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest();
  let providedSig;
  try {
    providedSig = Buffer.from(
      sigB64.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (sigB64.length % 4)) % 4),
      "base64"
    );
  } catch (_) {
    return null;
  }
  if (
    expectedSig.length !== providedSig.length ||
    !crypto.timingSafeEqual(expectedSig, providedSig)
  ) {
    return null;
  }
  const [email, specialty] = payload.split("|", 2);
  if (!email || !specialty) return null;
  return { email, specialty };
}

async function insertUnsubscribe({ email, specialty, source, userAgent, ipHash }) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/unsubscribes`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      email,
      specialty,
      source,
      user_agent: userAgent || null,
      ip_hash: ipHash || null,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${detail}`);
  }
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: "Method Not Allowed — use POST",
    };
  }

  const secret = process.env.MCB_UNSUB_SECRET;
  if (!secret) {
    console.error("MCB_UNSUB_SECRET not configured");
    return { statusCode: 500, headers: corsHeaders, body: "Server misconfigured" };
  }

  const token =
    (event.queryStringParameters && event.queryStringParameters.t) ||
    (event.queryStringParameters && event.queryStringParameters.token);
  const verified = verifyToken(token, secret);
  if (!verified) {
    return { statusCode: 400, headers: corsHeaders, body: "Invalid or expired token" };
  }

  // Distinguish a mailbox-provider one-click (no UA or generic bot UA, no
  // origin header) from a confirmed click on our page. Best-effort labelling.
  const ua = event.headers["user-agent"] || "";
  const origin = event.headers["origin"] || event.headers["referer"] || "";
  const isFromOurPage = origin.includes("mondayclinicalbrief.co.uk");
  const source = isFromOurPage ? "confirm-page" : "one-click";

  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    null;

  try {
    await insertUnsubscribe({
      email: verified.email,
      specialty: verified.specialty,
      source,
      userAgent: ua.slice(0, 200),
      ipHash: hashIp(ip),
    });
  } catch (err) {
    console.error("Unsubscribe insert failed:", err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: "Could not record unsubscribe — please email info@mondayclinicalbrief.co.uk",
    };
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "ok", email: verified.email, specialty: verified.specialty }),
  };
};
