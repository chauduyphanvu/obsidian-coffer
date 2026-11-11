const bp = (u: Uint8Array) => u as unknown as BlobPart;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bp(data)]).stream().pipeThrough(stream)).arrayBuffer());
}

export const deflate = (data: Uint8Array) => pipe(data, new CompressionStream('deflate-raw'));
export const inflate = (data: Uint8Array) => pipe(data, new DecompressionStream('deflate-raw'));

const INCOMPRESSIBLE = new Set(
  'jpg jpeg png gif webp avif heic pdf zip gz 7z rar mp3 m4a ogg flac mp4 mov mkv webm docx xlsx pptx epub'.split(' '),
);

export function worthCompressing(path: string, size: number): boolean {
  if (size < 256) return false;
  const dot = path.lastIndexOf('.');
  return dot < 0 || !INCOMPRESSIBLE.has(path.slice(dot + 1).toLowerCase());
}
