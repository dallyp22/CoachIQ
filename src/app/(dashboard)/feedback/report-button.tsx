"use client";

import { useState } from "react";
import { ReportModal } from "./report-modal";

/**
 * The Report button on the /feedback page header. The floating variant in the
 * app chrome (FloatingReport) opens the same modal.
 */
export function ReportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded hover:bg-accent-hover transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        Report
      </button>
      {open && <ReportModal onClose={() => setOpen(false)} />}
    </>
  );
}
