import { loadOfficial } from "../../../lib/official.js"

// Keep the current official Host half; only the client resolver differs.
const official = await loadOfficial("@deepseek-ai/dsh-client-resources")
export const apply = official.apply
