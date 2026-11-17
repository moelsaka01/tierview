// Builds a tiny git repo with an uncommitted change touching docs, a formatter,
// a lockfile and an auth query, for the README demo.
// Usage: node demo/make-sample-repo.mjs <new-empty-dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node make-sample-repo.mjs <new-empty-dir>");
if (existsSync(dir)) throw new Error(`${dir} already exists; pass a new directory`);
mkdirSync(join(dir, "src"), { recursive: true });
const git = (...a) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...a], { cwd: dir, stdio: "ignore" });
const w = (p, s) => writeFileSync(join(dir, p), s);

w("README.md", "# shop\n\nA tiny shop API.\n");
w("src/format.ts", "export function money(c: number) {\n  return `$${(c / 100).toFixed(2)}`;\n}\n");
w("src/auth.ts", [
  'import { db } from "./db";',
  "",
  "export async function login(user: string, pass: string) {",
  '  const row = await db.get("SELECT * FROM users WHERE name = ?", [user]);',
  "  if (!row) return null;",
  "  return verify(pass, row.hash) ? row : null;",
  "}",
  "",
].join("\n"));
w("package-lock.json", '{\n  "lockfileVersion": 3,\n  "packages": { "node_modules/left-pad": { "version": "1.3.0" } }\n}\n');
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "init");

w("README.md", "# shop\n\nA tiny shop API. Now with login.\n");
w("src/format.ts", "export function money(c: number) {\n  return `$${(c / 100).toFixed(2)}`;\n}\n\nexport const CURRENCY = \"USD\";\n");
w("src/auth.ts", [
  'import { db } from "./db";',
  "",
  "export async function login(user: string, pass: string) {",
  "  const row = await db.get(`SELECT * FROM users WHERE name = '${user}'`);",
  "  if (!row) return null;",
  "  return pass === row.password ? row : null;",
  "}",
  "",
].join("\n"));
w("package-lock.json", '{\n  "lockfileVersion": 3,\n  "packages": { "node_modules/left-pad": { "version": "1.3.1" } }\n}\n');
