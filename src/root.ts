// Locates the package root (the folder holding config/). Works from src/ and from the bundled dist/.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Path inside the package's config/ folder. */
export function configPath(name: string): string {
  return join(here, "..", "config", name);
}
