// Approve-from-email flow for the Guise family tree Lambda.
//
// The email button opens a confirm page in a new tab (GET). Nothing changes
// until "Add to the tree" is pressed on that page (POST). Gmail and virus
// scanners open links in emails on their own, so the GET must stay harmless.
//
// ASSUMPTIONS (check against the real handler before wiring in):
//   - Submissions live in DynamoDB table process.env.TABLE_NAME, key `id`,
//     with `status` ("pending" | "live" | "approved" | "taken_down"),
//     `kind` ("person"), and `payload` holding what the form sent.
//   - payload for a new person looks like:
//       { relation: "child" | "partner", relativeId, relativeName,
//         person: { name, born, birthPlace, died?, deathPlace? },
//         from: { name, email } }
//   - `signingKey` is the same secret the "Take it down" HMAC uses, so
//     rotating the passcode invalidates approve links as well.
//   - rebuildGallery() is the existing scan-and-rewrite of gallery.json.

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;
const SITE = "https://guisefamilytree.com";

// ---------- signing ----------

export function sign(action, id, signingKey) {
  return crypto.createHmac("sha256", signingKey)
    .update(`${action}:${id}`).digest("base64url");
}

function verify(action, id, sig, signingKey) {
  if (!id || !sig) return false;
  const want = Buffer.from(sign(action, id, signingKey));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function approveUrl(functionUrl, id, signingKey) {
  const u = new URL(functionUrl);
  u.searchParams.set("action", "approve");
  u.searchParams.set("id", id);
  u.searchParams.set("sig", sign("approve", id, signingKey));
  return u.toString();
}

// ---------- email button ----------
// Drop this into the archivist email for person submissions, beside
// "Take it down". Table-based so it renders in Gmail, Outlook and Apple Mail.
// target="_blank" makes the confirm page open in a new tab.

export function approveButtonHtml(url) {
  return `
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0">
  <tr>
    <td style="background:#2f5d3a;border-radius:6px">
      <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
         style="display:inline-block;padding:12px 22px;color:#ffffff;
                font:600 15px/1 Georgia,'Times New Roman',serif;
                text-decoration:none">Add to the tree</a>
    </td>
  </tr>
</table>
<p style="margin:0;color:#6b6b6b;font:13px/1.4 Arial,sans-serif">
  Opens a page where you confirm. Nothing is added until you press the button there.
</p>`;
}

// ---------- request handling ----------
// Call this from the main handler when the query has action=approve.
// Returns a Function URL response, or null if this isn't an approve request.

export async function handleApprove(event, { signingKey, rebuildGallery }) {
  const q = event.queryStringParameters || {};
  if (q.action !== "approve") return null;

  const method = event.requestContext?.http?.method || "GET";
  const id = q.id;

  if (!verify("approve", id, q.sig, signingKey)) {
    return page(403, "This link doesn't work",
      `<p>The link is incomplete, or the family passcode has been changed since it was sent.
       Run <code>./scripts/submissions.sh</code> to see what is still waiting.</p>`);
  }

  const { Item: sub } = await db.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  if (!sub || sub.kind !== "person") {
    return page(404, "Submission not found",
      `<p>There's no person submission with this id. It may have been removed.</p>`);
  }

  const p = sub.payload || {};
  const who = escapeHtml(p.person?.name || "This person");

  if (sub.status === "approved") {
    return page(200, `${who} is already on the tree`,
      `<p>This was approved earlier, so there's nothing more to do.</p>${siteLink()}`);
  }
  if (sub.status === "taken_down") {
    return page(409, `${who} was taken down`,
      `<p>This submission was removed. Ask the family member to send it again if it should go back.</p>`);
  }

  if (method === "GET") {
    return page(200, `Add ${who} to the tree?`, `
      ${details(p)}
      <form method="POST">
        <button type="submit">Add to the tree</button>
      </form>
      <p class="quiet">They'll appear on guisefamilytree.com for everyone straight away.
      "Take it down" in the email still removes them.</p>`);
  }

  if (method === "POST") {
    try {
      await db.send(new UpdateCommand({
        TableName: TABLE,
        Key: { id },
        UpdateExpression: "SET #s = :approved, approvedAt = :now",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":approved": "approved", ":pending": "pending",
          ":now": new Date().toISOString(),
        },
      }));
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      // Someone pressed it twice, or it changed in between: fall through.
    }
    await rebuildGallery();
    return page(200, `${who} has been added`,
      `<p>They're on the tree now. Reload the site to see them.</p>${siteLink()}`);
  }

  return page(405, "Not allowed", "");
}

// ---------- gallery.json additions ----------
// Inside the existing rebuildGallery(), after the table scan, add:
//
//   gallery.additions = toAdditions(items);
//
// The browser applies these to tree.json before layout (src/lib/additions.ts).
// Operations rather than finished people/unions, because only the browser has
// tree.json and knows which union a parent is in.

export function toAdditions(items) {
  return items
    .filter((it) => it.kind === "person" && it.status === "approved")
    .sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt)))
    .map((it) => ({
      submissionId: it.id,
      op: it.payload.relation === "partner" ? "addPartner" : "addChild",
      relativeId: it.payload.relativeId,
      unionId: it.payload.unionId ?? null,
      person: { id: `live-${it.id}`, ...it.payload.person },
    }));
}

// ---------- page shell ----------

function details(p) {
  const rel = p.relation === "partner" ? "partner of" : "child of";
  const rows = [
    ["Adding", `<strong>${escapeHtml(p.person?.name)}</strong> as ${rel} ${escapeHtml(p.relativeName)}`],
    p.person?.born && ["Born", escapeHtml(p.person.born)],
    p.person?.birthPlace && ["Born at", escapeHtml(p.person.birthPlace)],
    p.person?.died && ["Died", escapeHtml(p.person.died)],
    p.from && ["Sent by", `${escapeHtml(p.from.name)} &lt;${escapeHtml(p.from.email)}&gt;`],
  ].filter(Boolean);
  return `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function siteLink() {
  return `<p><a href="${SITE}">Open the family tree</a></p>`;
}

function page(statusCode, title, body) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
    body: `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --ink:#1f2a24; --leaf:#2f5d3a; --paper:#fbfbf8; --line:#d9ddd6; --quiet:#5d665f; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--paper); color:var(--ink);
         font:17px/1.55 Georgia,"Times New Roman",serif; }
  main { max-width:34rem; margin:12vh auto; padding:0 1.25rem; }
  h1 { font-size:1.6rem; line-height:1.25; font-weight:normal; margin:0 0 1.5rem; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:.4rem 1.25rem;
       margin:0 0 2rem; padding:1.25rem 0; border-block:1px solid var(--line); }
  dt { color:var(--quiet); } dd { margin:0; }
  button { font:inherit; font-size:1.05rem; color:#fff; background:var(--leaf);
           border:0; border-radius:6px; padding:.8rem 1.6rem; cursor:pointer; width:100%; }
  button:focus-visible, a:focus-visible { outline:3px solid #9cc3a6; outline-offset:2px; }
  button[disabled] { opacity:.6; cursor:default; }
  .quiet { color:var(--quiet); font-size:.9rem; margin-top:1rem; }
  a { color:var(--leaf); }
  code { font-size:.85em; }
</style></head>
<body><main><h1>${title}</h1>${body}</main>
<script>
  // Stop a double tap sending the POST twice.
  document.querySelector("form")?.addEventListener("submit", e => {
    const b = e.target.querySelector("button"); b.disabled = true; b.textContent = "Adding…";
  });
</script>
</body></html>`,
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;
