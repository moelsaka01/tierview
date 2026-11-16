// Unified diff -> Hunk[]. Spec: PLAN.md §4 (Hunk.id) and §8.
import type { DiffLine, FileStatus, Hunk } from "../types";

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return p;
}

function stripPrefix(p: string): string {
  return unquote(p).replace(/^[ab]\//, "");
}

/** Best-effort path split of "a/X b/X" for headers with no ---/+++ or rename lines. */
function pathFromGitHeader(rest: string): string {
  const m = /^"?a\/(.+?)"? "?b\/(.+)"?$/.exec(rest);
  if (m && m[1] === m[2]) return m[2] as string;
  const half = rest.length >> 1;
  return stripPrefix(rest.slice(half + 1));
}

export function parseDiffFiles(text: string): FileDiff[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] as string).replace(/\r$/, "");
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    const file: FileDiff = {
      path: pathFromGitHeader(line.slice("diff --git ".length)),
      status: "modified",
      binary: false,
      hunks: [],
    };
    let oldPath: string | undefined;
    let newPath: string | undefined;
    i++;
    // extended header
    for (; i < lines.length; i++) {
      const l = (lines[i] as string).replace(/\r$/, "");
      if (l.startsWith("diff --git ") || l.startsWith("@@")) break;
      if (l.startsWith("new file mode")) file.status = "added";
      else if (l.startsWith("deleted file mode")) file.status = "deleted";
      else if (l.startsWith("rename from ")) {
        file.status = "renamed";
        oldPath = unquote(l.slice("rename from ".length));
      } else if (l.startsWith("rename to ")) newPath = unquote(l.slice("rename to ".length));
      else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) file.binary = true;
      else if (l.startsWith("--- ")) {
        const p = l.slice(4);
        if (p !== "/dev/null") oldPath ??= stripPrefix(p);
      } else if (l.startsWith("+++ ")) {
        const p = l.slice(4);
        if (p !== "/dev/null") newPath = stripPrefix(p);
      }
    }
    if (file.status === "deleted") file.path = oldPath ?? file.path;
    else file.path = newPath ?? file.path;
    if (file.status === "renamed") file.oldPath = oldPath;

    // hunks
    let n = 0;
    while (i < lines.length && !(lines[i] as string).startsWith("diff --git ")) {
      const m = HUNK_RE.exec((lines[i] as string).replace(/\r$/, ""));
      if (!m) {
        i++;
        continue;
      }
      i++;
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      const body: DiffLine[] = [];
      let oldNo = oldStart;
      let newNo = newStart;
      let oldLeft = oldLines;
      let newLeft = newLines;
      let added = 0;
      let deleted = 0;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] as string).startsWith("\\"))) {
        const raw = lines[i] as string;
        if (raw.startsWith("\\")) {
          i++;
          continue;
        }
        const c = raw[0];
        const text = raw.slice(1);
        if (c === "+") {
          body.push({ kind: "add", text, newNo: newNo++ });
          newLeft--;
          added++;
        } else if (c === "-") {
          body.push({ kind: "del", text, oldNo: oldNo++ });
          oldLeft--;
          deleted++;
        } else {
          // context line; an empty line is a context line whose space was stripped
          body.push({ kind: "ctx", text: c === " " ? text : raw, oldNo: oldNo++, newNo: newNo++ });
          oldLeft--;
          newLeft--;
        }
        i++;
      }
      n++;
      file.hunks.push({
        id: `${file.path}#${n}`,
        file: file.path,
        ...(file.oldPath ? { oldFile: file.oldPath } : {}),
        status: file.status,
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: (m[5] ?? "").trim(),
        lines: body,
        added,
        deleted,
      });
    }
    files.push(file);
  }
  return files;
}

export function parseDiff(text: string): Hunk[] {
  return parseDiffFiles(text).flatMap((f) => f.hunks);
}

/** Render a hunk back to unified-diff text (used by prompts and token estimates). */
export function formatHunk(h: Hunk): string {
  const out = [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.header}`.trimEnd()];
  for (const l of h.lines) out.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  return out.join("\n");
}
