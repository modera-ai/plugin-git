import { opendir, readFile } from "@modera/plugin-sdk/workspace-fs";
import { join } from "@modera/plugin-sdk/workspace-path";
import createIgnore from "ignore";

const excluded = new Set([
  ".git",
  ".modera",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
]);
/** Bounded discovery for ordinary folders. No watcher and no Git initialization. */
export async function workspaceFiles(root: string, signal: AbortSignal) {
  const rules = createIgnore();
  for (const name of [".gitignore", ".ignore"])
    rules.add(await readFile(join(root, name), "utf8").catch(() => ""));
  const paths: string[] = [];
  let entries = 0,
    incomplete = false;
  const visit = async (folder: string) => {
    signal.throwIfAborted();
    const children = await opendir(join(root, folder));
    for await (const entry of children) {
      signal.throwIfAborted();
      if (++entries > 10_000 || paths.length >= 2000) {
        incomplete = true;
        return;
      }
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (
        excluded.has(entry.name.toLowerCase()) ||
        rules.ignores(entry.isDirectory() ? `${path}/` : path)
      )
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
      if (incomplete) return;
    }
  };
  await visit("");
  return { paths, incomplete };
}
