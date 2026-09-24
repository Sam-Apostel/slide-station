// Place names for the browser version (slidestation/places.py, function by function): GeoNames'
// cities15000 searched by any Latin-script name, typed coordinates named after the nearest city, and
// the place a sign names ("WELCOME TO VENICE"). download.geonames.org sends no CORS headers, so the
// page downloads a pinned daily snapshot from a Hugging Face dataset that mirrors it (DataDock/geonames,
// CC BY 4.0 like GeoNames), into the same data/geonames/ folder of the library as the desktop app.
import type { Place } from "./store";
import type { ModelSource } from "./models";

export const GAZETTEER: ModelSource = {
  repo: "https://huggingface.co/datasets/DataDock/geonames/resolve/8ec8c62780f8afe834b04df2a036e06ebf931d73/2026-09-15/",
  files: [
    [
      "cities15000.zip",
      "cities15000.zip",
      3342294,
      "sha256:32399fa9c0729d4e342773651acde46d02a5727462d80d26436b1515a1e9a33b",
    ],
    ["countryInfo.txt", "countryInfo.txt", 31678, "git:c371e3e8558930bba630d766570ecf760d0c86a0"],
    ["admin1CodesASCII.txt", "admin1CodesASCII.txt", 151536, "git:57e734c271cfdabc534f05c53cee43ea1ad67fd1"],
  ],
};
export const GAZETTEER_DIR = "data/geonames";
export const GAZETTEER_MB = 4;

/** Search form of a name (places.fold): accents off, lower case, anything but letters and digits a space. */
export function fold(s: string): string {
  const t = s
    .replace(/ß/g, "ss")
    .replace(/[øØ]/g, "o")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
  return t
    .replace(/[^0-9a-z]+/g, " ")
    .trim()
    .split(/ +/)
    .filter(Boolean)
    .join(" ");
}

const latin = (s: string) => [...s].every((c) => c.codePointAt(0)! < 0x250 || /\p{Mn}/u.test(c) || "ʼ’‘ ".includes(c));
const isUpper = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

/** "45.4371, 12.3326" (or with a space / semicolon) as [lat, lon]; null if it isn't that. */
export function parseCoords(q: string): [number, number] | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q);
  if (!m) return null;
  const [lat, lon] = [Number(m[1]), Number(m[2])];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

export const coordsLabel = (lat: number, lon: number) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** The cities of GeoNames' cities15000, searchable by any of their Latin-script names (places.Gazetteer). */
export class Gazetteer {
  names: string[] = [];
  admin: string[] = [];
  country: string[] = [];
  pop: number[] = [];
  ids: number[] = [];
  lat: number[] = [];
  lon: number[] = [];
  /** folded name -> cities, a city's own name before an alternate one, then the bigger city */
  exact = new Map<string, number[]>();
  /** "key\tcity": the city's own (or ASCII) name, not an alternate one */
  primary = new Set<string>();
  private keys: string[];

  constructor(cities: string, countryInfo: string, admin1: string) {
    const countries = new Map<string, string>();
    for (const ln of countryInfo.split("\n"))
      if (ln && !ln.startsWith("#")) {
        const f = ln.split("\t");
        countries.set(f[0], f[4]);
      }
    const admins = new Map<string, string>();
    for (const ln of admin1.split("\n")) {
      const f = ln.split("\t");
      if (f.length >= 2) admins.set(f[0], f[1]);
    }
    const keys = new Map<string, Set<number>>();
    const add = (k: string, i: number) => {
      if (!keys.has(k)) keys.set(k, new Set());
      keys.get(k)!.add(i);
    };
    for (const ln of cities.split("\n")) {
      const f = ln.split("\t");
      if (f.length < 15) continue;
      const i = this.names.length;
      this.ids.push(Math.trunc(Number(f[0])));
      this.names.push(f[1]);
      this.lat.push(Number(f[4]));
      this.lon.push(Number(f[5]));
      this.country.push(countries.get(f[8]) ?? f[8]);
      this.admin.push(admins.get(`${f[8]}.${f[10]}`) ?? "");
      this.pop.push(Math.trunc(Number(f[14] || 0)));
      for (const n of [f[1], f[2]]) {
        const k = fold(n);
        if (!k) continue;
        add(k, i);
        this.primary.add(`${k}\t${i}`);
      }
      for (const n of f[3].split(",")) {
        // alternate names: Latin script only, and not codes (IATA "VCE", "ALV")
        if (n.length < 3 || (isUpper(n) && n.length <= 4) || !latin(n)) continue;
        const k = fold(n);
        if (k) add(k, i);
      }
    }
    for (const [k, v] of keys)
      this.exact.set(
        k,
        [...v].sort(
          (a, b) =>
            +!this.primary.has(`${k}\t${a}`) - +!this.primary.has(`${k}\t${b}`) || this.pop[b] - this.pop[a] || a - b,
        ),
      );
    this.keys = [...this.exact.keys()].sort();
  }

  get size() {
    return this.names.length;
  }

  isPrimary = (k: string, i: number) => this.primary.has(`${k}\t${i}`);

  place(i: number): Place {
    const p: Place = {
      name: this.names[i],
      lat: r5(this.lat[i]),
      lon: r5(this.lon[i]),
      country: this.country[i],
      id: this.ids[i],
    };
    if (this.admin[i]) p.admin = this.admin[i];
    return p;
  }

  private lower(key: string) {
    let [lo, hi] = [0, this.keys.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Places whose name starts with what was typed, best first; "Venice, Italy" narrows by country / region. */
  search(q: string, limit = 8): Place[] {
    const at = q.indexOf(",");
    const [key, where] = at < 0 ? [fold(q), ""] : [fold(q.slice(0, at)), fold(q.slice(at + 1))];
    if (!key) return [];
    const hits = new Map<number, [number, number, number]>();
    for (const k of this.keys.slice(this.lower(key), this.lower(key + "~")))
      for (const i of this.exact.get(k)!) {
        if (where && !(fold(this.country[i]).startsWith(where) || fold(this.admin[i]).startsWith(where))) continue;
        const rank: [number, number, number] = [+(k !== key), +!this.isPrimary(k, i), -this.pop[i]];
        const was = hits.get(i);
        if (!was || cmp(rank, was) < 0) hits.set(i, rank);
      }
    return [...hits.keys()]
      .sort((a, b) => cmp(hits.get(a)!, hits.get(b)!))
      .slice(0, limit)
      .map((i) => this.place(i));
  }

  /** The closest city to a point, if one is within `withinKm`. */
  nearest(lat: number, lon: number, withinKm = 25): Place | null {
    const rad = Math.PI / 180;
    let [best, km] = [-1, Infinity];
    for (let i = 0; i < this.lat.length; i++) {
      const [la, lo] = [this.lat[i] * rad, this.lon[i] * rad];
      const a =
        Math.sin((la - lat * rad) / 2) ** 2 + Math.cos(la) * Math.cos(lat * rad) * Math.sin((lo - lon * rad) / 2) ** 2;
      const d = 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
      if (d < km) [best, km] = [i, d];
    }
    return best >= 0 && km <= withinKm ? this.place(best) : null;
  }
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** What the place field offers for `q` (places.search): typed coordinates first (named after the
 *  nearest city when there is one), else gazetteer matches. */
export function search(g: Gazetteer | null, q: string, limit = 8): Place[] {
  const ll = parseCoords(q);
  if (ll) {
    const near = g?.nearest(ll[0], ll[1]) ?? null;
    const p: Place = {
      name: near?.name ?? coordsLabel(ll[0], ll[1]),
      lat: r5(ll[0]),
      lon: r5(ll[1]),
      country: near?.country ?? "",
    };
    if (near?.admin) p.admin = near.admin;
    return [p];
  }
  return g ? g.search(q, limit) : [];
}

// ------------------------------------------------------------------ text -> place (places.py)

const CUES = [
  "welcome to", "greetings from", "bienvenue a", "bienvenue au", "bienvenue en", "willkommen in",
  "benvenuti a", "benvenuti in", "benvenuto a", "bienvenidos a", "bienvenido a", "welkom in", "welkom te",
  "bem vindo a", "bem vindos a", "vitajte v", "witamy w", "velkommen til", "valkommen till", "gruss aus",
  "grusse aus", "souvenir de", "ricordo di", "recuerdo de", "greetings of",
]; // prettier-ignore
const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const COMMON = words(`
bar nice split best deal mobile reading bath most sale open exit stop taxi bus hotel park post police bank
museum center centre city beach station opera parking central university college victoria orange paradise
hope independence union liberty concord hollywood harmony industry commerce enterprise progress victory
welcome eden mission bay port porto santa san saint st east west north south la le de del el los las
hall market gate bridge church castle lake mountain river valley view avenue street road place plaza
cafe restaurant bakery pizza shop store tourist information entrance ausgang eingang sortie entree
uscita entrata salida entrada zimmer frei rooms camping pension tabac apotheke pharmacie farmacia office
marina airport metro plage playa coca cola castello riviera kodak agfa fuji ilford ektachrome kodachrome
agfachrome sakura polaroid esso shell texaco total mobil garage auto sport grand royal palace imperial
metropol metropole europa bellevue belvedere panorama miramar splendid excelsior savoy ritz astoria
continental majestic ocean harbour harbor pier lido`);
const NOT_AFTER = words(`via viale corso piazza piazzale largo vicolo rue avenue boulevard bd place quai chemin allee
calle avenida plaza paseo carrer rua strasse str gasse platz weg straat laan plein hotel albergo pension
gasthof gasthaus restaurant ristorante trattoria pizzeria cafe caffe bar brasserie hostal hostel
pensione`);
const NOT_BEFORE = words(`road street st avenue ave lane way square station airlines airline airways air express
match hotel restaurant cafe bar strasse str gasse platz weg straat laan plein boulevard bd club fc
bank insurance`);
const BIG = 100_000;
const MIN_CONFIDENCE = 0.3;

export type Line = { text: string; confidence?: number };

/** The best place named in the text of a photo (places.place_from_text), as {place, confidence, text}. */
export function placeFromText(
  lines: Line[],
  gaz: Gazetteer,
): { place: Place; confidence: number; text: string } | null {
  let best: { place: Place; confidence: number; text: string } | null = null;
  const texts: [string, number][] = lines.map((l) => [l.text, l.confidence ?? 1]);
  // a cue on one line and the name on the next ("WELCOME TO" / "VENICE"): read those together too
  for (let i = 0; i + 1 < lines.length; i++)
    texts.push([`${texts[i][0]} ${texts[i + 1][0]}`, Math.min(texts[i][1], texts[i + 1][1])]);
  for (const [text, ocrConf] of texts) {
    const ws = fold(text).split(" ").filter(Boolean);
    const spans: [number, number][] = [];
    for (const n of [3, 2, 1])
      for (let i = 0; i + n <= ws.length; i++) {
        const key = ws.slice(i, i + n).join(" ");
        let ids = gaz.exact.get(key);
        if (!ids || spans.some(([a, b]) => a <= i && i + n <= b)) continue; // inside a longer match
        spans.push([i, i + n]);
        const before = ws.slice(Math.max(0, i - 3), i).join(" ");
        let base: number;
        if (CUES.some((c) => before.endsWith(c))) base = 0.9;
        else {
          const prev = i ? ws[i - 1] : "";
          const nxt = i + n < ws.length ? ws[i + n] : "";
          if (
            key.replace(/ /g, "").length < 4 ||
            COMMON.has(key) ||
            /^\d+$/.test(key) ||
            NOT_AFTER.has(prev) ||
            NOT_BEFORE.has(nxt)
          )
            continue;
          ids = ids.filter((j) => gaz.isPrimary(key, j) || gaz.pop[j] >= BIG);
          if (!ids.length) continue;
          base = key.length >= 6 ? 0.6 : 0.45;
        }
        const own = ids.filter((j) => gaz.isPrimary(key, j));
        const pops = (own.length ? own : ids).map((j) => Math.max(gaz.pop[j], 1));
        const share = pops[0] / pops.reduce((a, b) => a + b, 0);
        const conf = base * ocrConf * (0.5 + 0.5 * share);
        if (!best || conf > best.confidence)
          best = { place: gaz.place(ids[0]), confidence: Math.round(conf * 1000) / 1000, text };
      }
  }
  return best && best.confidence >= MIN_CONFIDENCE ? best : null;
}

// ------------------------------------------------------------------ reading the zip

/** One file out of a zip (stored or deflated), through the browser's own inflate. */
export async function unzipEntry(zip: Blob, name: string): Promise<Uint8Array> {
  const buf = new Uint8Array(await zip.arrayBuffer());
  const v = new DataView(buf.buffer);
  let end = buf.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file");
  let p = v.getUint32(end + 16, true);
  const count = v.getUint16(end + 10, true);
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const [method, size, nameLen, extra, comment, local] = [
      v.getUint16(p + 10, true),
      v.getUint32(p + 20, true),
      v.getUint16(p + 28, true),
      v.getUint16(p + 30, true),
      v.getUint16(p + 32, true),
      v.getUint32(p + 42, true),
    ];
    if (new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)) === name) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`Unsupported zip compression ${method}`);
      const out = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(out).arrayBuffer());
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} isn't in the zip`);
}
