// Just enough EXIF: read make / model / date from a scan, and write the tags Immich reads into a
// finished JPEG (canvas encoders drop all metadata). Mirrors what workflow.render_export writes.

export type ScanInfo = { make: string; model: string; datetime: string; orientation?: number };

/** Make (271), Model (272) and DateTime (306, else DateTimeOriginal) of a JPEG, "" when absent. */
export function readExif(buf: ArrayBuffer): ScanInfo {
  const out: ScanInfo = { make: "", model: "", datetime: "" };
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return out;
  let o = 2;
  while (o + 4 <= v.byteLength) {
    const marker = v.getUint16(o);
    const len = v.getUint16(o + 2);
    if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return { ...out, ...tiff(v, o + 10) };
    if (marker === 0xffda || (marker & 0xff00) !== 0xff00) break; // pixels start: no EXIF
    o += 2 + len;
  }
  return out;
}

function tiff(v: DataView, base: number): Partial<ScanInfo> {
  try {
    const le = v.getUint16(base) === 0x4949;
    const u16 = (o: number) => v.getUint16(base + o, le);
    const u32 = (o: number) => v.getUint32(base + o, le);
    const tags = new Map<number, string>();
    let orientation = 1;
    const ascii = (entry: number) => {
      const n = u32(entry + 4);
      const at = n <= 4 ? entry + 8 : u32(entry + 8);
      let s = "";
      for (let i = 0; i < n; i++) {
        const c = v.getUint8(base + at + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    };
    const ifd = (off: number, depth: number) => {
      const n = u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        const tag = u16(e);
        const type = u16(e + 2);
        if (type === 2) tags.set(tag, ascii(e));
        else if (tag === 274 && type === 3 && depth === 0) orientation = u16(e + 8);
        else if (tag === 0x8769 && depth === 0) ifd(u32(e + 8), 1);
      }
    };
    ifd(u32(4), 0);
    const datetime = tags.get(306) || tags.get(36867) || "";
    return { make: tags.get(271) ?? "", model: tags.get(272) ?? "", datetime, orientation };
  } catch {
    return {};
  }
}

type Tag = [number, string];

type Entry = { t: number; type: number; data: Uint8Array | null; value?: number; count?: number };

/** Degrees as three EXIF rationals (degrees, minutes, seconds / 10000), little endian. */
function dms(x: number): Uint8Array {
  const a = Math.abs(x);
  const d = Math.floor(a);
  const m = Math.floor(a * 60) % 60;
  const s = Math.round(((a * 3600) % 60) * 10000);
  const out = new Uint8Array(24);
  const v = new DataView(out.buffer);
  [d, 1, m, 1, s, 10000].forEach((n, i) => v.setUint32(i * 4, n, true));
  return out;
}

/** The GPS IFD's entries for a place (workflow.gps_ifd): version 2.3, N/S + latitude, E/W + longitude. */
function gpsEntries(lat: number, lon: number): Entry[] {
  const enc = new TextEncoder();
  return [
    { t: 0, type: 1, data: new Uint8Array([2, 3, 0, 0]) },
    { t: 1, type: 2, data: enc.encode(lat >= 0 ? "N\0" : "S\0") },
    { t: 2, type: 5, data: dms(lat), count: 3 },
    { t: 3, type: 2, data: enc.encode(lon >= 0 ? "E\0" : "W\0") },
    { t: 4, type: 5, data: dms(lon), count: 3 },
  ];
}

/** An APP1 EXIF segment (little endian) with the given ASCII tags in IFD0 and the Exif IFD, and
 *  GPS coordinates when the slide has a place. */
export function exifSegment(ifd0: Tag[], exif: Tag[], orientation = 1, gps?: { lat: number; lon: number }): Uint8Array {
  const enc = new TextEncoder();
  const entries0: Entry[] = [
    ...ifd0.map(([t, s]) => ({ t, type: 2, data: enc.encode(s + "\0") })),
    { t: 274, type: 3, data: null, value: orientation },
  ];
  const entriesX: Entry[] = exif.map(([t, s]) => ({ t, type: 2, data: enc.encode(s + "\0") }));
  const entriesG = gps ? gpsEntries(gps.lat, gps.lon) : [];
  entries0.push({ t: 0x8769, type: 4, data: null, value: 0 }); // pointers, filled in below
  if (gps) entries0.push({ t: 0x8825, type: 4, data: null, value: 0 });
  entries0.sort((a, b) => a.t - b.t);
  entriesX.sort((a, b) => a.t - b.t);
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const dataSize = (es: Entry[]) =>
    es.reduce((s, e) => s + (e.data && e.data.length > 4 ? e.data.length + (e.data.length % 2) : 0), 0);
  const off0 = 8;
  const offX = off0 + ifdSize(entries0.length) + dataSize(entries0);
  const offG = offX + ifdSize(entriesX.length) + dataSize(entriesX);
  const total = offG + (gps ? ifdSize(entriesG.length) + dataSize(entriesG) : 0);
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  b.set([0x49, 0x49, 0x2a, 0x00]);
  v.setUint32(4, off0, true);
  const writeIfd = (at: number, es: Entry[]) => {
    v.setUint16(at, es.length, true);
    let data = at + ifdSize(es.length);
    es.forEach((e, i) => {
      const p = at + 2 + i * 12;
      v.setUint16(p, e.t, true);
      v.setUint16(p + 2, e.type, true);
      if (e.data) {
        v.setUint32(p + 4, e.count ?? e.data.length, true);
        if (e.data.length <= 4) b.set(e.data, p + 8);
        else {
          v.setUint32(p + 8, data, true);
          b.set(e.data, data);
          data += e.data.length + (e.data.length % 2);
        }
      } else {
        v.setUint32(p + 4, 1, true);
        if (e.type === 3) v.setUint16(p + 8, e.value ?? 0, true);
        else v.setUint32(p + 8, e.t === 0x8769 ? offX : e.t === 0x8825 ? offG : (e.value ?? 0), true);
      }
    });
    v.setUint32(at + 2 + es.length * 12, 0, true); // no next IFD
  };
  writeIfd(off0, entries0);
  writeIfd(offX, entriesX);
  if (gps) writeIfd(offG, entriesG);
  const seg = new Uint8Array(4 + 6 + total);
  const sv = new DataView(seg.buffer);
  sv.setUint16(0, 0xffe1);
  sv.setUint16(2, 2 + 6 + total);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(b, 10);
  return seg;
}

/** An APP1 XMP segment with the slide's tags as dc:subject (keywords; Immich reads them as tags
 *  too), the packet workflow.xmp_subjects writes. */
export function xmpSegment(tags: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = tags.map((t) => `<rdf:li>${esc(t)}</rdf:li>`).join("");
  const packet = new TextEncoder().encode(
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:subject><rdf:Bag>${items}</rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>` +
      '<?xpacket end="w"?>',
  );
  const ns = new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0");
  const seg = new Uint8Array(4 + ns.length + packet.length);
  new DataView(seg.buffer).setUint16(0, 0xffe1);
  new DataView(seg.buffer).setUint16(2, 2 + ns.length + packet.length);
  seg.set(ns, 4);
  seg.set(packet, 4 + ns.length);
  return seg;
}

/** The JPEG with an EXIF segment (and any others, e.g. XMP) right after its start marker. */
export async function withExif(jpeg: Blob, ...segments: Uint8Array[]): Promise<Blob> {
  const head = new Uint8Array(await jpeg.slice(0, 2).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) throw new Error("Not a JPEG");
  return new Blob([jpeg.slice(0, 2), ...(segments as BlobPart[]), jpeg.slice(2)], { type: "image/jpeg" });
}
