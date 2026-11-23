// How the plugin keeps a JSON state file so that an app stopped halfway through saving it still finds a whole one.
// No Obsidian import, so it runs under plain Node tests.

/** The few file operations it needs, as Obsidian's adapter has them. */
export interface StateFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat?(path: string): Promise<{ size: number } | null>;
}

const WRITE_TRIES = 3;

/**
 * Runs `write`, then checks that the file at `path` holds `length` bytes, and writes again when it does not. On Android,
 * Obsidian's write now and then leaves an empty file and reports nothing (about 1 in 200 on 1.15.1; a second write
 * succeeds). Without the check a sync records the empty file as the version it downloaded. Returns the file's stat.
 */
export async function writeWhole<S extends { size: number }>(stat: (path: string) => Promise<S | null>, path: string, length: number, write: () => Promise<unknown>): Promise<S> {
  for (let attempt = 1; ; attempt++) {
    await write();
    const s = await stat(path);
    if (s && s.size === length) return s;
    if (attempt === WRITE_TRIES) throw new Error(`Could not write ${path}: it holds ${s?.size ?? 0} of ${length} bytes`);
  }
}

const side = (path: string) => `${path}.tmp`;

const whole = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Writes the new text beside the file, then puts it in the file's place. Never renames over a file, which not every
 * platform allows: the old one goes first. Stopped at any point, the file or the copy beside it is whole.
 */
export async function saveState(files: StateFiles, path: string, data: string): Promise<void> {
  // An empty copy must never take the file's place: see `writeWhole`. Its length in bytes is not known without encoding it, so only empty is told apart.
  for (let attempt = 1; ; attempt++) {
    await files.write(side(path), data);
    const s = data && files.stat ? await files.stat(side(path)) : undefined;
    if (!s || s.size > 0) break;
    if (attempt === WRITE_TRIES) throw new Error(`Could not write ${side(path)}: it is empty`);
  }
  if (await files.exists(path)) await files.remove(path);
  await files.rename(side(path), path);
}

/** The file's text; the copy beside it when the file is missing or not whole and the copy is; null when there is neither. */
export async function loadState(files: StateFiles, path: string): Promise<string | null> {
  const text = (await files.exists(path)) ? await files.read(path) : null;
  if (text !== null && whole(text)) return text;
  if (await files.exists(side(path))) {
    const copy = await files.read(side(path));
    if (whole(copy)) return copy;
  }
  return text;
}

/** Removes the file and any copy beside it, which would otherwise stand in for it at the next load. */
export async function removeState(files: StateFiles, path: string): Promise<void> {
  for (const p of [path, side(path)]) if (await files.exists(p)) await files.remove(p);
}
