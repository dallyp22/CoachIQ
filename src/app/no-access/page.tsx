import { SignOutButton } from "@clerk/nextjs";

/**
 * Shown when a signed-in Clerk account has no coach record on this practice.
 * Before multi-coach, any account that could sign in saw everything; this is
 * where those accounts land now.
 */
export default function NoAccessPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 bg-background">
      <div className="max-w-md text-center">
        <h1 className="font-display text-[32px] text-foreground">No access</h1>
        <p className="text-sm text-muted mt-3 leading-relaxed">
          This account isn&apos;t registered as a coach on this practice. If you were
          invited recently, make sure you signed in with the address the invitation
          was sent to.
        </p>
        <p className="text-sm text-muted mt-4">
          Need access? Ask the practice owner to add you in Settings → Coaches.
        </p>
        <div className="mt-8">
          <SignOutButton>
            <button className="text-sm font-medium text-accent hover:underline">
              Sign out and try another account
            </button>
          </SignOutButton>
        </div>
      </div>
    </main>
  );
}
