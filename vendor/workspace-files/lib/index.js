import { loadOfficial } from "../../../lib/official.js"

const official = await loadOfficial("@deepseek-ai/dsh-api-workspace-files")
export const WorkspaceFiles = official.WorkspaceFiles
export default official.default
