/**
 * Minimal tar reader for GitHub repo tarballs — Workers-safe (no node
 * built-ins; DecompressionStream + TextDecoder are Web platform).
 *
 * Handles exactly what GitHub emits: ustar headers (name 0–99, octal size
 * 124–135, typeflag 156, prefix 345–499), a leading pax_global_header, and
 * data padded to 512-byte blocks. pax/GNU extended headers ('x'/'g'/'L')
 * are skipped with their data; the prefix field covers paths to 255 chars,
 * which is plenty for a knowledge bundle.
 */

const BLOCK = 512;
const decoder = new TextDecoder();

function readString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}

function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  const raw = readString(bytes, offset, length).trim();
  return raw ? parseInt(raw, 8) : 0;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK && i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * Parse a (already gunzipped) tarball into path → text content, stripping
 * the single top-level directory GitHub prepends ({owner}-{repo}-{sha}/).
 */
export function parseTar(bytes: Uint8Array): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;

  while (offset + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break; // two zero blocks end the archive

    const name = readString(bytes, offset, 100);
    const size = readOctal(bytes, offset + 124, 12);
    const typeflag = bytes[offset + 156];
    const prefix = readString(bytes, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // '0' (0x30) or NUL = regular file; everything else (dirs '5', pax
    // 'x'/'g', GNU longname 'L', symlinks...) is skipped with its data.
    if ((typeflag === 0x30 || typeflag === 0) && size >= 0 && dataEnd <= bytes.length) {
      const slash = fullName.indexOf("/");
      if (slash !== -1) {
        const relPath = fullName.slice(slash + 1);
        if (relPath) files.set(relPath, decoder.decode(bytes.subarray(dataStart, dataEnd)));
      }
    }
    offset = paddedEnd;
  }
  return files;
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** Gunzip via the Web platform; passes through if the bytes aren't gzip. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== GZIP_MAGIC_0 || bytes[1] !== GZIP_MAGIC_1) return bytes;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
