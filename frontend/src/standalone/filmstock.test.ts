// The browser's film stock port against filmstock.py: filmstock.fixture.json holds inputs and what
// Python made of them (tests/make_filmstock_fixture.py writes it).
import { describe, expect, it } from "vitest";
import fixture from "./filmstock.fixture.json";
import { dateSuggestions, heuristic, Labels, stockSuggestions, views, type StockExample } from "./filmstock";
import { slideDates, type SessionData } from "./store";

const tray = fixture.tray as unknown as SessionData;
const close = (a: Record<string, number>, b: Record<string, number>) => {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  for (const k of Object.keys(b)) expect(a[k]).toBeCloseTo(b[k], 9);
};

describe("film stock, as filmstock.py", () => {
  it("fade heuristic", () => {
    for (const [k, f] of Object.entries(fixture.features))
      close(heuristic(f), (fixture.heuristic as Record<string, Record<string, number>>)[k]);
  });

  it("k-NN over labelled slides", () => {
    const labels = new Labels({ examples: fixture.labels });
    expect(labels.known).toEqual(["agfachrome", "kodachrome"]);
    for (const [k, f] of Object.entries(fixture.features)) {
      const [p, n] = labels.predict(f);
      const [want, wn] = (fixture.predict as Record<string, [Record<string, number> | null, number]>)[k];
      expect(n).toBe(wn);
      if (want) close(p!, want);
      else expect(p).toBeNull();
    }
  });

  it("suggestions per slide: heuristic, k-NN, dates", () => {
    expect(stockSuggestions(tray, new Labels(null))).toEqual(fixture.stock_heuristic);
    expect(stockSuggestions(tray, new Labels({ examples: fixture.labels }))).toEqual(fixture.stock_knn);
    const dates = slideDates(tray);
    expect(dates).toEqual(fixture.slide_dates); // era hints included, the values as before
    expect(dateSuggestions(tray, dates)).toEqual(fixture.date_suggestions);
  });

  it("decisions stand while the guess doesn't change", () => {
    const d = structuredClone(tray);
    const guess = fixture.stock_heuristic[0]!;
    d.groups[0].insights = { stock: { ...guess, state: "dismissed" } };
    d.groups[1].insights = { stock: { ...guess, value: "agfachrome", state: "dismissed" } };
    d.groups[2].insights = { date: { value: "1970", confidence: 0.9, source: "mount-ocr", state: "suggested" } };
    const v = views(d, slideDates(d), new Labels(null));
    expect(v[0].stock?.state).toBe("dismissed"); // same value: stays away
    expect(v[1].stock).toEqual(fixture.stock_heuristic[1]); // another value: offered
    expect(v[2].date?.source).toBe("mount-ocr"); // a model's own suggestion wins
  });

  it("labels: remember only writes a change", () => {
    const saved: unknown[] = [];
    const l = new Labels(null, (j) => saved.push(j));
    const f = fixture.features.kodachrome0;
    l.remember("t:a", f, "kodachrome");
    l.remember("t:a", f, "kodachrome");
    expect(saved.length).toBe(1);
    l.remember("t:a", f, "ektachrome");
    l.forget("t:a");
    l.forget("t:a");
    expect(saved.length).toBe(3);
    expect((saved[2] as { examples: StockExample[] }).examples).toEqual([]);
  });
});
