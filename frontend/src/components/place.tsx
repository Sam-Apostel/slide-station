// The slide's place: typed with autocomplete from the offline gazetteer (GeoNames cities, desktop
// app), or as coordinates ("45.4371, 12.3326", optionally after a name) — the only way in the
// browser version, which can't fetch GeoNames (no CORS there). Goes to Immich as latitude /
// longitude and into the export as EXIF GPS. Or on the little map: click, or drag the pin.
import * as React from "react";
import { Check, Download, Map as MapIcon, MapPin, MapPinned, X } from "lucide-react";
import { ProButton } from "@/components/ui/pro-button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/tip";
import { whySuggested } from "@/components/insights";
import { PlaceMiniMap, placeAt } from "@/components/atlas-map";
import { api, placeLabel, type Place, type PlacesAnswer, type Suggestion } from "@/lib/api";

const coords = (p: Place) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;

const MAP_KEY = "place-map"; // the little map shown or not, remembered
const mapShown = () => {
  try {
    return localStorage.getItem(MAP_KEY) === "1";
  } catch {
    return false;
  }
};

/** "Venice 45.4371, 12.3326" or "45.4371, 12.3326": a place of your own, named or not. */
export function typedPlace(q: string): Place | null {
  const m = /^(.*?)[\s,;]*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q.trim());
  if (!m) return null;
  const lat = Number(m[2]);
  const lon = Number(m[3]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const name = m[1].trim();
  return name ? { name, lat, lon, country: "" } : null; // unnamed: the server names it (nearest city)
}

export function PlaceField({
  place,
  suggestion,
  onDecide,
  onChange,
  onRange,
  downloading,
  onDownload,
}: {
  place: Place | null | undefined;
  /** The slide's place suggestion (from a sign, or its neighbours), shown while it is open. */
  suggestion?: Suggestion | null;
  onDecide: (action: "accept" | "dismiss", value: string) => void;
  onChange: (p: Place | null) => void;
  /** Give a run of slides this place (the propagation dialog). */
  onRange: () => void;
  /** The place names are being downloaded (a job). */
  downloading: boolean;
  onDownload: () => void;
}) {
  const id = React.useId();
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [results, setResults] = React.useState<Place[]>([]);
  const [active, setActive] = React.useState(0);
  const [ready, setReady] = React.useState<boolean | null>(null);
  const seq = React.useRef(0);
  const [map, setMap] = React.useState(mapShown);
  const toggleMap = () =>
    setMap((v) => {
      try {
        localStorage.setItem(MAP_KEY, v ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !v;
    });
  const pickSeq = React.useRef(0);
  const pickOnMap = async (lat: number, lon: number) => {
    const n = ++pickSeq.current;
    const p = await placeAt(lat, lon);
    if (n === pickSeq.current) onChange(p);
  };

  React.useEffect(() => {
    api<PlacesAnswer>("GET", "/api/places").then(
      (r) => setReady(r.ready),
      () => setReady(false),
    );
  }, [downloading]);

  React.useEffect(() => {
    const text = q.trim();
    if (!text) return setResults([]);
    const n = ++seq.current;
    const t = window.setTimeout(async () => {
      const own = typedPlace(text);
      try {
        const r = await api<PlacesAnswer>("GET", `/api/places?q=${encodeURIComponent(own ? coords(own) : text)}`);
        if (n !== seq.current) return;
        setReady(r.ready);
        // a name typed before the coordinates wins over the nearest city's
        setResults(own ? [own] : r.results);
      } catch {
        if (n === seq.current) setResults(own ? [own] : []);
      }
      setActive(0);
    }, 120);
    return () => window.clearTimeout(t);
  }, [q]);

  const pick = (p: Place) => {
    setQ("");
    setOpen(false);
    setResults([]);
    onChange(p);
  };
  const listId = `${id}-list`;
  const showList = open && q.trim() !== "" && results.length > 0;
  const hint = ready ? "Type a town or city, or coordinates" : "Coordinates, e.g. 45.4371, 12.3326";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center">
        <label htmlFor={id} className="flex-1 text-[11px] text-muted-foreground">
          Place
        </label>
        <Tip label={map ? "Hide the map" : "Show a map: click it or drag the pin to set the place"}>
          <button
            type="button"
            className="ss-tag-add"
            aria-label={map ? "Hide the map" : "Show the map"}
            aria-pressed={map}
            onClick={toggleMap}
          >
            <MapIcon />
          </button>
        </Tip>
      </div>
      {!place && suggestion?.state === "suggested" && (
        // the same suggestion as in Insights; here too, so neighbours' places show without the tag model
        <div className="ss-suggestion">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">Suggested: </span>
            {suggestion.value}
          </span>
          <Tip label={`${Math.round(suggestion.confidence * 100)}% sure (${whySuggested(suggestion)})`}>
            <span className="ss-confidence" style={{ "--c": suggestion.confidence } as React.CSSProperties}>
              {Math.round(suggestion.confidence * 100)}%
            </span>
          </Tip>
          <Tip label="Use as the slide's place">
            <button
              type="button"
              aria-label={`Accept ${suggestion.value}`}
              onClick={() => onDecide("accept", suggestion.value)}
            >
              <Check />
            </button>
          </Tip>
          <Tip label="Dismiss: it won't be suggested for this slide again">
            <button
              type="button"
              aria-label={`Dismiss ${suggestion.value}`}
              onClick={() => onDecide("dismiss", suggestion.value)}
            >
              <X />
            </button>
          </Tip>
        </div>
      )}
      {place && (
        <div className="flex items-center gap-1">
          <span className="ss-tag min-w-0" title={coords(place)}>
            <MapPin className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{placeLabel(place, true)}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{coords(place)}</span>
            <button type="button" aria-label="Remove place" onClick={() => onChange(null)}>
              <X />
            </button>
          </span>
          <Tip label="Give a run of slides this place, e.g. 12–31">
            <button type="button" className="ss-tag-add" aria-label="Apply place to a range" onClick={onRange}>
              <MapPinned />
            </button>
          </Tip>
        </div>
      )}
      <div className="relative">
        <Input
          id={id}
          className="h-7"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={q}
          placeholder={place ? "Change place" : hint}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const d = e.key === "ArrowDown" ? 1 : -1;
              setActive((a) => (results.length ? (a + d + results.length) % results.length : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (showList && results[active]) pick(results[active]);
            } else if (e.key === "Escape") {
              setQ("");
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
        />
        {showList && (
          <ul id={listId} role="listbox" aria-label="Places" className="ss-place-list">
            {results.map((p, i) => (
              <li
                key={`${p.id ?? ""}${p.name}${p.lat}${p.lon}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
              >
                <span className="truncate">{placeLabel(p, true)}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{coords(p)}</span>
              </li>
            ))}
            {ready && (
              // GeoNames' licence (CC BY 4.0) asks for the credit
              <li role="none" className="ss-place-credit">
                Place names © GeoNames, CC BY 4.0
              </li>
            )}
          </ul>
        )}
      </div>
      {map && (
        <PlaceMiniMap
          place={place}
          onPick={pickOnMap}
          className="h-[160px] overflow-hidden rounded-md border border-(--ss-line-soft)"
        />
      )}
      {ready === false && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {downloading ? (
            "Downloading place names — progress is at the top."
          ) : (
            <>
              <span>Search by name needs the place names (GeoNames, ~3 MB).</span>
              <ProButton plain onClick={onDownload}>
                <Download /> Download
              </ProButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}
