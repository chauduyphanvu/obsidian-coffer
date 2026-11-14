// How the plugin keeps a JSON state file so that an app stopped halfway through saving it still finds a whole one.
// No Obsidian import, so it runs under plain Node tests.

/** The few file operations it needs, as Obsidian's adapter has them. */
export interface StateFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
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
  await files.write(side(path), data);
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
