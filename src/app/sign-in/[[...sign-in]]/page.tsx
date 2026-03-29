import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-full items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="font-display text-4xl text-foreground mb-2">CoachIQ</h1>
        <p className="text-sm text-muted mb-8">
          Coaching intelligence for Co-Create Coaching
        </p>
        <SignIn forceRedirectUrl="/" />
      </div>
    </div>
  );
}
