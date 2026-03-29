-- Add API key fields to coach_settings
ALTER TABLE "coach_settings" ADD COLUMN "openaiApiKey" TEXT;
ALTER TABLE "coach_settings" ADD COLUMN "anthropicApiKey" TEXT;
ALTER TABLE "coach_settings" ADD COLUMN "stripeSecretKey" TEXT;
