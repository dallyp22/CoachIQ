/**
 * Content script — bridge between CoachIQ page and the extension's background worker.
 * Injected on CoachIQ domains. Relays postMessage ↔ chrome.runtime.sendMessage.
 */

// Tell the page the extension is installed
window.postMessage({ type: "COACHIQ_NLM_EXTENSION_READY" }, "*");

// Listen for sync requests from the CoachIQ page
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "COACHIQ_NLM_SYNC") {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "nlm-sync",
        payload: event.data.payload,
      });
      window.postMessage(
        { type: "COACHIQ_NLM_SYNC_RESULT", payload: response },
        "*"
      );
    } catch (err) {
      window.postMessage(
        {
          type: "COACHIQ_NLM_SYNC_RESULT",
          payload: {
            success: false,
            error: err instanceof Error ? err.message : "Extension error",
          },
        },
        "*"
      );
    }
  }

  if (event.data?.type === "COACHIQ_NLM_CHECK_AUTH") {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "nlm-check-auth",
      });
      window.postMessage(
        { type: "COACHIQ_NLM_AUTH_RESULT", payload: response },
        "*"
      );
    } catch (err) {
      window.postMessage(
        {
          type: "COACHIQ_NLM_AUTH_RESULT",
          payload: { authenticated: false },
        },
        "*"
      );
    }
  }
});
