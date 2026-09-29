import { loadOfficial } from "../../../lib/official.js"

const official = await loadOfficial("@deepseek-ai/dsh-client-ui-settings")
export const Config = official.Config
export const apply = official.apply
