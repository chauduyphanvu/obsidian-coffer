import { concat } from './bytes.ts';
import { ext } from './paths.ts';

// Fed and drained directly: wrapping the data in a Blob and a Response costs more than compressing a small note.
async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // A failure shows up on the reading side too; these only keep it from also being reported as unhandled.
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Compressed data unpacks to more than ${max} bytes`);
    }
    parts.push(value);
  }
  return parts.length ? concat(parts) : new Uint8Array(0);
}

export const deflate = (data: Uint8Array) => pipe(data, new CompressionStream('deflate-raw'));
/**
 * Throws once the output passes `max` bytes, without unpacking the rest: a few hundred kilobytes can unpack to
 * gigabytes, and whoever holds a member share's key can store such a thing.
 */
export const inflate = (data: Uint8Array, max: number) => pipe(data, new DecompressionStream('deflate-raw'), max);

const INCOMPRESSIBLE = new Set(
  'jpg jpeg png gif webp avif heic pdf zip gz 7z rar mp3 m4a ogg flac mp4 mov mkv webm docx xlsx pptx epub'.split(' '),
);

export function worthCompressing(path: string, size: number): boolean {
  if (size < 256) return false;
  return !INCOMPRESSIBLE.has(ext(path));
}
