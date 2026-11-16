// Rules about vault paths that every part of the engine must agree on.

// No character below U+0300 changes under NFC or combines with one before it (Unicode's NFC quick check starts there),
// so most paths can skip `normalize`, which costs more than the rest of the scan's work on a path.
const MAY_CHANGE_UNDER_NFC = /[^\u0000-˿]/;

/** Paths are compared in NFC so the same name typed on macOS and elsewhere is one file. */
export const vaultKey = (path: string) => (MAY_CHANGE_UNDER_NFC.test(path) ? path.normalize('NFC') : path);

/** Index of the dot that starts the file name's extension, or `path.length` when there is none. */
function extensionDot(path: string): number {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? dot : path.length;
}

/** The last part of a path: `a/b.md` → `b.md`. */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Lower-case extension without the dot; empty when the file name has none. */
export function ext(path: string): string {
  return path.slice(extensionDot(path) + 1).toLowerCase();
}

/** Where this device's side of a conflict is kept: `a/b.md` → `a/b (conflict laptop 20260102-150405).md`, then `… 2).md`. */
export function conflictCopyName(key: string, device: string, time: Date, n = 1): string {
  const two = (x: number) => String(x).padStart(2, '0');
  const stamp = `${time.getFullYear()}${two(time.getMonth() + 1)}${two(time.getDate())}-${two(time.getHours())}${two(time.getMinutes())}${two(time.getSeconds())}`;
  const dot = extensionDot(key);
  return `${key.slice(0, dot)} (conflict ${device.replace(/[^\w-]+/g, '_')} ${stamp}${n > 1 ? ` ${n}` : ''})${key.slice(dot)}`;
}

/** The file a conflict copy was made from: the inverse of `conflictCopyName`. */
export const conflictOriginal = (copy: string) => copy.replace(/ \(conflict [\w-]+ \d{8}-\d{6}(?: \d+)?\)(?=(\.[^./]*)?$)/, '');
