/**
 * MC Markets CS — Jira Ticket Sync
 * GitHub Actions version
 *
 * Reads credentials from environment variables (injected from GitHub Secrets).
 * Fetches tickets from Jira Cloud and writes them to Firebase Realtime Database.
 *
 * Required GitHub Secrets:
 *   JIRA_BASE_URL            e.g. https://mcmarkets-team.atlassian.net
 *   JIRA_USER_EMAIL          Atlassian account email used to generate the API token
 *   JIRA_API_TOKEN           Jira API token
 *   JIRA_CS_ACCOUNT_IDS      Comma-separated Atlassian account IDs of CS reporters
 *   FIREBASE_DATABASE_URL    e.g. https://jira-ticket-tracker-5f22f-default-rtdb.asia-southeast1.firebasedatabase.app
 *   FIREBASE_SERVICE_ACCOUNT Firebase service account key JSON (as a single-line string)
 */

const admin = require("firebase-admin");

// ── Firebase init ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function mapStatus(jiraStatus) {
  const s = (jiraStatus || "").toLowerCase();
  if (s === "in progress") return "progress";
  if (s === "done")        return "resolved";
  return "open";
}

function extractText(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  const parts = [];
  function traverse(node) {
    if (!node) return;
    if (node.type === "text" && node.text) parts.push(node.text);
    if (node.type === "hardBreak") parts.push("\n");
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
      if (["paragraph","bulletList","orderedList","listItem","heading"].includes(node.type)) {
        parts.push("\n");
      }
    }
  }
  traverse(adf);
  return parts.join("").trim();
}

// ── Main sync ────────────────────────────────────────────────────────────────
async function sync() {
  const base   = process.env.JIRA_BASE_URL;
  const email  = process.env.JIRA_USER_EMAIL;
  const token  = process.env.JIRA_API_TOKEN;
  const rawIds = process.env.JIRA_CS_ACCOUNT_IDS;

  const idList = rawIds
    .split(",")
    .map(id => `"${id.trim()}"`)
    .join(",");

  const jql = `project = N8N AND reporter in (${idList}) ORDER BY created DESC`;

  const fields = [
    "summary", "status", "priority", "assignee",
    "reporter", "created", "description", "attachment", "components",
  ].join(",");

  const auth = Buffer.from(`${email}:${token}`).toString("base64");

  const response = await fetch(
    `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Jira API error ${response.status}: ${errText}`);
  }

  const data   = await response.json();
  const issues = data.issues || [];
  const tickets = {};

  for (const issue of issues) {
    const key = issue.key.replace("-", "_");
    tickets[key] = {
      id:             issue.key,
      title:          issue.fields.summary || "",
      status:         mapStatus(issue.fields.status?.name),
      assignee:       issue.fields.assignee?.displayName ?? "未分配",
      reporter:       issue.fields.reporter?.displayName ?? "",
      description:    extractText(issue.fields.description),
      hasAttachments: (issue.fields.attachment?.length ?? 0) > 0,
      jiraUrl:        `${base}/browse/${issue.key}`,
      created:        issue.fields.created ? issue.fields.created.slice(0, 10) : null,
      syncedAt:       Date.now(),
    };
  }

  await admin.database().ref("jira/tickets").set(tickets);
  console.log(`✓ Synced ${issues.length} tickets to Firebase.`);
  process.exit(0);
}

sync().catch(err => {
  console.error("Sync failed:", err.message);
  process.exit(1);
});
