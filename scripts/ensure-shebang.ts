import { readFileSync, writeFileSync } from "node:fs"

const path = "dist/cli.js"
const body = readFileSync(path, "utf8").replace(/^(#!.*\n)+/, "")
writeFileSync(path, `#!/usr/bin/env node\n${body}`)
