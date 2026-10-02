// The TestFlight waitlist: one SQLite file in DATA_DIR (a Railway volume in production).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = process.env.DATA_DIR ?? path.join(import.meta.dirname, "data");
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, "waitlist.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS waitlist (
    email      TEXT PRIMARY KEY COLLATE NOCASE,
    device     TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    invited_at TEXT
  );
`);

export const DEVICES = ["ipad", "iphone", "both"];
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;

/** Adds an address; joining twice is fine (the device is updated). Returns an error message or null. */
export function join(email, device) {
  email = String(email ?? "").trim();
  if (email.length > 254 || !EMAIL.test(email)) return "That doesn't look like an email address.";
  device = DEVICES.includes(device) ? device : null;
  db.prepare(
    `INSERT INTO waitlist (email, device) VALUES (?, ?)
     ON CONFLICT (email) DO UPDATE SET device = coalesce(excluded.device, device)`,
  ).run(email, device);
  return null;
}

export function count() {
  return db.prepare("SELECT count(*) AS n FROM waitlist").get().n;
}

export function csv() {
  const rows = db.prepare("SELECT email, device, created_at, invited_at FROM waitlist ORDER BY created_at").all();
  const cell = (v) => {
    if (v == null) return "";
    const s = /^[=+\-@]/.test(v) ? `'${v}` : String(v); // no formulas when opened in a spreadsheet
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return ["email,device,created_at,invited_at", ...rows.map((r) => Object.values(r).map(cell).join(","))].join("\n") + "\n";
}
