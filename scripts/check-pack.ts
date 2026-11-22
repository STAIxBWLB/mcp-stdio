import { execFileSync } from "node:child_process";

const parsed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] as { files: { path: string }[] };
const allowed = (path: string) => path === "package.json" || path === "README.md" || path === "LICENSE" || path.startsWith("src/") || path.startsWith("fixtures/v1/");
for (const file of pack.files) if (!allowed(file.path)) throw new Error(`unexpected package file: ${file.path}`);
