import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Read-only access to a YNAB4 folder for the importer (src/import/ynab4.ts). Only the files
// the importer needs are listed or read, and nothing is ever written.

/** Budget.ymeta, devices/*.ydevice, <device>/Budget.yfull and <device>/*.ydiff. */
function isYnab4File(name: string): boolean {
  return name === 'Budget.ymeta' || name === 'Budget.yfull' || name.endsWith('.ydevice') || name.endsWith('.ydiff');
}

/** Folders that never hold live budget data: YNAB4 backups and exports. */
const SKIP_DIRS = /^(backups?|exports?)$/i;

/** Deep enough for Documents/YNAB/<budget>.ynab4/<data folder>/<device>/<file>. */
const MAX_DEPTH = 5;

/**
 * Lists the YNAB4 files under `dir` as POSIX paths relative to it, e.g.
 * "Home Budget~1A2B3C4D.ynab4/data1~5E6F7A8B/devices/A.ydevice". Symbolic links are not
 * followed, and folders that can't be read are passed over.
 */
export async function listYnab4Files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.test(e.name))
          await walk(path.join(abs, e.name), rel + e.name + '/', depth + 1);
      } else if (e.isFile() && isYnab4File(e.name)) {
        out.push(rel + e.name);
      }
    }
  };
  await walk(path.resolve(dir), '', 0);
  return out.sort();
}

/** True when `target` is `root` itself or inside it. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Reads one file listed by `listYnab4Files`. Refuses anything that isn't a YNAB4 data file
 * or that is outside `dir` (including through "..", an absolute path or a symbolic link).
 */
export async function readYnab4File(dir: string, relPath: string): Promise<string> {
  const refuse = () => new Error(`Refusing to read "${relPath}": it is not a YNAB4 file in the chosen folder.`);
  if (!relPath || relPath.includes('\0') || path.isAbsolute(relPath) || /^[a-z]:/i.test(relPath)) throw refuse();
  const root = path.resolve(dir);
  const target = path.resolve(root, relPath);
  if (target === root || !isInside(root, target) || !isYnab4File(path.basename(target))) throw refuse();
  // Check again with links resolved, so a link inside the folder can't point outside it.
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isInside(realRoot, realTarget)) throw refuse();
  return readFile(realTarget, 'utf8');
}
