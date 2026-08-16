import pkg from "../../package.json";

/**
 * The running app version (MAJOR.MINOR.PATCH.MICRO), sourced from package.json
 * so it is bundled at build time and available on Vercel without reading a file
 * at runtime. Kept out of the VERSION file read path because that file is a
 * source artifact Next may not trace into the serverless bundle.
 */
export const APP_VERSION: string = pkg.version ?? "unknown";
