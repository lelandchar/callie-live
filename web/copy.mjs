// Publish the built bundle where the Callie server serves it: ../public/call/
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, "..", "public", "call");
rmSync(dest, { recursive: true, force: true });
cpSync(path.join(here, "dist"), dest, { recursive: true, filter: (src) => !src.endsWith("_headers") });
console.log("copied bundle to", dest);
