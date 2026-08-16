"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { ReportModal } from "@/app/(dashboard)/feedback/report-modal";

/**
 * A Report affordance on every page, so a coach files a bug at the moment they
 * hit it — the modal captures the page they're on. Hidden on /feedback, which
 * has its own Report button in the header.
 */
export function FloatingReport() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (pathname.startsWith("/feedback")) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Report a bug or request a feature"
        className="fixed bottom-20 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-medium text-white shadow-lg transition-colors hover:bg-accent-hover lg:bottom-6 lg:right-6"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.17 48.17 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.39 48.39 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
          />
        </svg>
        <span className="hidden sm:inline">Report</span>
      </button>
      {open && <ReportModal onClose={() => setOpen(false)} />}
    </>
  );
}
