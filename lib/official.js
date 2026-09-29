import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

const officialRequire = createRequire(realpathSync(process.argv[1]))

/** Load the official package that ships inside this dsh install, not a profile shadow. */
export function loadOfficial(specifier) {
  return import(pathToFileURL(officialRequire.resolve(specifier)).href)
}
