import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Static-heavy marketing site: no ISR/revalidation, so no R2 incremental cache
// override is needed. Add one here later if a route starts using revalidate.
export default defineCloudflareConfig({});
