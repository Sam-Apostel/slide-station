// The grouping signatures are cached as numpy .npy files, like the Python app does, so a tray
// can be continued in either app. Only what's needed: float32 C-order arrays.

export function npy(data: Float32Array, shape: number[]): Blob {
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += " ".repeat(pad % 64) + "\n";
  const head = new Uint8Array(10 + header.length);
  head.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  new DataView(head.buffer).setUint16(8, header.length, true);
  head.set(new TextEncoder().encode(header), 10);
  return new Blob([head, data as BlobPart]);
}

export async function readNpy(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const v = new DataView(buf);
  const major = v.getUint8(6);
  const hlen = major === 1 ? v.getUint16(8, true) : v.getUint32(8, true);
  const start = (major === 1 ? 10 : 12) + hlen;
  const header = new TextDecoder().decode(new Uint8Array(buf, major === 1 ? 10 : 12, hlen));
  if (!header.includes("<f4")) throw new Error("Unexpected signature format");
  return new Float32Array(buf.slice(start));
}
