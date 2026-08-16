"use client";

import { useEffect } from "react";

/**
 * Marks feedback read when the page mounts, clearing the nav badge. Fire-and-
 * forget — a failed call just leaves the badge for next time, no user impact.
 * The badge itself is computed in the dashboard layout, so it updates on the
 * next navigation rather than mid-view (which is the right feel: you opened the
 * page, you've seen it).
 */
export function MarkSeen() {
  useEffect(() => {
    fetch("/api/feedback/seen", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}
