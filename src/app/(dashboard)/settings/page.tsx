import { requireCoachPage } from "@/lib/authz-page";
import { SettingsForm } from "./settings-form";
import { CoachesSection } from "./coaches";
import { PipelineStagesSection } from "./pipeline-stages";

export const dynamic = "force-dynamic";

/**
 * Settings is practice-level configuration — Stripe, AI keys, invoice
 * numbering, coach management, the billing Danger Zone. ADMIN and above only;
 * a COACH has no business here even reading masked values.
 *
 * Per-coach self-serve settings (own calendar, own title filter) are a
 * separate surface, not yet built — an admin edits those on a coach's behalf.
 */
export default async function SettingsPage() {
  const coach = await requireCoachPage("ADMIN");

  return (
    <div className="space-y-6">
      <SettingsForm />
      <CoachesSection viewerRole={coach.role} />
      <PipelineStagesSection />
    </div>
  );
}
