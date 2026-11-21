/**
 * Reads the voice packs of a Kitten TTS repository: `.npz` archives (zip files of
 * `.npy` float32 arrays, as written by numpy.savez). Only what those files use is
 * supported: stored or deflated entries, little-endian float32 C-order arrays.
 */

export interface VoicePack {
  /** Row-major float32 values, `rows` x 256. */
  readonly data: Float32Array;
  readonly rows: number;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries of a zip archive by name. */
export async function readZipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (readUint32(view, i) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Voice pack is not a zip archive.");
  const count = readUint16(view, end + 10);
  let offset = readUint32(view, end + 16);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (readUint32(view, offset) !== CENTRAL_HEADER) throw new Error("Voice pack directory is corrupt.");
    const method = readUint16(view, offset + 10);
    const compressedSize = readUint32(view, offset + 20);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const localOffset = readUint32(view, offset + 42);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (readUint32(view, localOffset) !== LOCAL_HEADER) throw new Error("Voice pack entry is corrupt.");
    const dataStart = localOffset + 30 + readUint16(view, localOffset + 26) + readUint16(view, localOffset + 28);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === STORED) entries.set(name, raw);
    else if (method === DEFLATED) entries.set(name, await inflateRaw(raw));
    else throw new Error(`Voice pack uses unsupported compression ${method}.`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One `.npy` array of little-endian float32 values. */
export function parseNpyFloat32(bytes: Uint8Array): VoicePack {
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== "NUMPY") {
    throw new Error("Voice pack entry is not an npy array.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLength = major === 1 ? readUint16(view, 8) : readUint32(view, 8);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength));
  if (!header.includes("'<f4'") || /'fortran_order':\s*True/.test(header)) {
    throw new Error("Voice pack array must be little-endian float32 in C order.");
  }
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1]?.split(",").map((part) => part.trim()).filter(Boolean);
  if (!shape || shape.length !== 2 || shape[1] !== "256") throw new Error("Voice pack has an unexpected shape.");
  const rows = Number(shape[0]);
  const count = rows * 256;
  const dataStart = headerStart + headerLength;
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = view.getFloat32(dataStart + i * 4, true);
  return { data, rows };
}

/** Voice name (without the `.npy` suffix) -> pack, for every array in the archive. */
export async function parseVoicePacks(bytes: Uint8Array): Promise<Map<string, VoicePack>> {
  const packs = new Map<string, VoicePack>();
  for (const [name, entry] of await readZipEntries(bytes)) {
    packs.set(name.replace(/\.npy$/, ""), parseNpyFloat32(entry));
  }
  return packs;
}
