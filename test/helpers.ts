import { loadConfig } from "../src/config";
import { compileRules } from "../src/tier0/signals";
import type { FileStatus, Hunk } from "../src/types";

export const cfg = loadConfig({ path: undefined, cwd: "test/fixtures/no-such-dir" });
export const rules = compileRules(cfg);

/** Build a hunk from lines prefixed with "+", "-" or " ". */
export function hunk(file: string, body: string[], status: FileStatus = "modified", n = 1): Hunk {
  let o = 1;
  let nw = 1;
  const lines = body.map((raw) => {
    const t = raw.slice(1);
    if (raw[0] === "+") return { kind: "add" as const, text: t, newNo: nw++ };
    if (raw[0] === "-") return { kind: "del" as const, text: t, oldNo: o++ };
    return { kind: "ctx" as const, text: t, oldNo: o++, newNo: nw++ };
  });
  const added = lines.filter((l) => l.kind === "add").length;
  const deleted = lines.filter((l) => l.kind === "del").length;
  return {
    id: `${file}#${n}`,
    file,
    status,
    oldStart: 1,
    oldLines: o - 1,
    newStart: 1,
    newLines: nw - 1,
    header: "",
    lines,
    added,
    deleted,
  };
}
