/**
 * Background service worker — makes authenticated requests to NotebookLM's internal API.
 * Uses ambient cookies from Todd's browser session (host_permissions grants access).
 */

const NLM_BASE = "https://notebooklm.google.com";
const NLM_API = `${NLM_BASE}/r/v1alpha1`;

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Referer: `${NLM_BASE}/`,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

// --- NLM API helpers ---

async function nlmFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `${NLM_API}${path}`;
  const resp = await fetch(url, {
    credentials: "include",
    headers: HEADERS,
    ...options,
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      "NLM_AUTH_EXPIRED: Please log in to NotebookLM in your browser"
    );
  }
  if (resp.status === 429) {
    throw new Error("NLM_RATE_LIMITED: Too many requests, try again shortly");
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`NLM API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function listNotebooks() {
  const data = await nlmFetch("/projects/-/notebooks?pageSize=200");
  return data.notebooks || [];
}

async function createNotebook(title) {
  const data = await nlmFetch("/projects/-/notebooks", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  // Extract notebook ID from the response name field (e.g. "projects/-/notebooks/abc123")
  const id = data.name ? data.name.split("/").pop() : data.id;
  return { id, name: data.name, title: data.title || title };
}

async function getNotebookSources(notebookId) {
  const data = await nlmFetch(
    `/projects/-/notebooks/${notebookId}/sources?pageSize=100`
  );
  return data.sources || [];
}

async function addTextSource(notebookId, text, title) {
  // NotebookLM's internal API for adding a text (paste) source
  const data = await nlmFetch(
    `/projects/-/notebooks/${notebookId}/sources`,
    {
      method: "POST",
      body: JSON.stringify({
        inlineText: {
          content: text,
        },
        displayName: title,
      }),
    }
  );
  const sourceId = data.name ? data.name.split("/").pop() : data.id;
  return { sourceId, title };
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "nlm-sync") {
    handleSync(message.payload)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: err.message })
      );
    return true; // keep channel open for async response
  }

  if (message.action === "nlm-check-auth") {
    listNotebooks()
      .then(() => sendResponse({ authenticated: true }))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }
});

async function handleSync(payload) {
  const { clients } = payload;
  const results = [];

  for (const client of clients) {
    let notebookId = client.notebookId;

    // Create notebook if client doesn't have one
    if (!notebookId) {
      try {
        const nb = await createNotebook(`CoachIQ | ${client.clientName}`);
        notebookId = nb.id;
      } catch (err) {
        // Mark all sessions for this client as failed
        for (const session of client.pendingSessions) {
          results.push({
            sessionId: session.sessionId,
            clientId: client.clientId,
            success: false,
            error: `Failed to create notebook: ${err.message}`,
          });
        }
        continue;
      }
    }

    // Check source count before injecting
    let sourceCount = 0;
    try {
      const sources = await getNotebookSources(notebookId);
      sourceCount = sources.length;
    } catch {
      // Non-fatal — proceed anyway
    }

    // Inject each pending session
    for (const session of client.pendingSessions) {
      if (sourceCount >= 50) {
        results.push({
          sessionId: session.sessionId,
          clientId: client.clientId,
          success: false,
          error: `Notebook at source limit (${sourceCount}/50)`,
        });
        continue;
      }

      try {
        const sourceTitle = `${session.date} — ${session.title}`;
        await addTextSource(notebookId, session.transcriptText, sourceTitle);
        sourceCount++;
        results.push({
          sessionId: session.sessionId,
          clientId: client.clientId,
          notebookId,
          success: true,
        });
      } catch (err) {
        results.push({
          sessionId: session.sessionId,
          clientId: client.clientId,
          success: false,
          error: err.message,
        });
        // If auth expired, stop all further processing
        if (err.message.includes("NLM_AUTH_EXPIRED")) {
          for (const remaining of client.pendingSessions.slice(
            client.pendingSessions.indexOf(session) + 1
          )) {
            results.push({
              sessionId: remaining.sessionId,
              clientId: client.clientId,
              success: false,
              error: "Skipped — auth expired",
            });
          }
          break;
        }
      }

      // Small delay between injections to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return { success: true, results, summary: { succeeded, failed } };
}
