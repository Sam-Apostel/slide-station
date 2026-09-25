// Maps (Leaflet): the places in People & Places — one dot per place, sized by its slides — and the
// slide's own place in the inspector, a pin to drag or put down with a click. The tiles are
// OpenStreetMap's own (no key; fine for one person's light use under its tile policy, credited),
// darkened in theme.css to sit with the app. Dots and pins need nothing from the network, so
// offline the places still show, on a blank background.
import * as React from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, type AtlasPlace, type Place, type PlacesAnswer } from "@/lib/api";
import { cn } from "@/lib/utils";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const AMBER = "#f2b34b";

/** A point on the map as a place: named after the nearest city when the place names are there
 *  (the same lookup as typing coordinates into the Place field), else by its coordinates. */
export async function placeAt(lat: number, lon: number): Promise<Place> {
  const wrap = ((((lon + 180) % 360) + 360) % 360) - 180; // the map repeats east and west
  const q = `${lat.toFixed(5)}, ${wrap.toFixed(5)}`;
  try {
    const r = await api<PlacesAnswer>("GET", `/api/places?q=${encodeURIComponent(q)}`);
    if (r.results[0]) return r.results[0];
  } catch {
    /* offline or old server: the coordinates will do */
  }
  return { name: `${lat.toFixed(4)}, ${wrap.toFixed(4)}`, lat: +lat.toFixed(5), lon: +wrap.toFixed(5), country: "" };
}

/** A Leaflet map on a div, with OSM tiles, kept sized to its box. The div is Leaflet's: React must
 *  never set its className (that wipes Leaflet's own classes), so maps render it inside a wrapper. */
function useLeaflet(box: React.RefObject<HTMLDivElement | null>, opts: L.MapOptions, view: [number, number, number]) {
  const [map, setMap] = React.useState<L.Map | null>(null);
  React.useEffect(() => {
    const m = L.map(box.current!, { worldCopyJump: true, ...opts }).setView([view[0], view[1]], view[2]);
    L.tileLayer(TILES, { attribution: CREDIT, maxZoom: 19, className: "ss-map-tiles" }).addTo(m);
    // panels and views change size: measure again
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current!);
    setMap(m);
    return () => {
      ro.disconnect();
      m.remove();
      setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return map;
}

export type MapPlace = AtlasPlace & { count: number };

export function AtlasMap({
  places,
  selected,
  onSelect,
  picking,
  onPick,
  className,
}: {
  /** The places to show (already filtered to a person, when one is picked). */
  places: MapPlace[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Placing slides: a click on the map (or on a place) is where they go. */
  picking?: boolean;
  onPick?: (lat: number, lon: number, place?: MapPlace) => void;
  className?: string;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const map = useLeaflet(box, { zoomControl: true }, [30, 10, 2]);
  const layer = React.useRef<L.LayerGroup | null>(null);
  const latest = React.useRef({ onSelect, onPick, picking });
  latest.current = { onSelect, onPick, picking };

  React.useEffect(() => {
    if (!map) return;
    layer.current = L.layerGroup().addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      const { picking, onPick, onSelect } = latest.current;
      if (picking && onPick) onPick(e.latlng.lat, e.latlng.lng);
      else onSelect(null);
    });
  }, [map]);

  // fit the view to the places whenever the set changes (a person picked), not on every selection
  const ids = places.map((p) => p.id).join("|");
  React.useEffect(() => {
    if (!map || !places.length) return;
    const bounds = L.latLngBounds(places.map((p) => [p.lat, p.lon] as [number, number]));
    map.fitBounds(bounds.pad(0.3), { maxZoom: 10, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ids]);

  // the chosen place: in view
  React.useEffect(() => {
    const p = places.find((x) => x.id === selected);
    if (map && p && !map.getBounds().pad(-0.1).contains([p.lat, p.lon])) map.panTo([p.lat, p.lon]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selected]);

  React.useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    const most = Math.max(1, ...places.map((p) => p.count));
    // big ones first, so small dots stay clickable on top
    for (const p of [...places].sort((a, b) => b.count - a.count)) {
      const on = p.id === selected;
      const c = L.circleMarker([p.lat, p.lon], {
        radius: 5 + 13 * Math.sqrt(p.count / most),
        color: on ? "#fff" : AMBER,
        weight: on ? 2.5 : 1.5,
        fillColor: AMBER,
        fillOpacity: on ? 0.85 : 0.45,
      });
      c.bindTooltip(`${p.name} · ${p.count} ${p.count === 1 ? "slide" : "slides"}`, { direction: "top" });
      c.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        const { picking, onPick, onSelect } = latest.current;
        if (picking && onPick) onPick(p.lat, p.lon, p);
        else onSelect(p.id);
      });
      c.addTo(g);
    }
  }, [map, places, selected]);

  return (
    <div
      className={cn("relative", className, picking && "ss-map-picking")}
      role="application"
      aria-label={picking ? "Map: click where the slides were taken" : "Map of the places on your slides"}
    >
      <div ref={box} className="absolute inset-0" />
    </div>
  );
}

const pinIcon = L.divIcon({ className: "ss-map-pin", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 17] });

/** The inspector's map of one slide's place: drag the pin, or click the map to put it there. */
export function PlaceMiniMap({
  place,
  onPick,
  className,
}: {
  place: Place | null | undefined;
  onPick: (lat: number, lon: number) => void;
  className?: string;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const map = useLeaflet(box, { zoomControl: false, attributionControl: true }, [30, 10, 1]);
  const pin = React.useRef<L.Marker | null>(null);
  const pick = React.useRef(onPick);
  pick.current = onPick;

  React.useEffect(() => {
    if (!map) return;
    L.control.zoom({ position: "topright" }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => pick.current(e.latlng.lat, e.latlng.lng));
  }, [map]);

  React.useEffect(() => {
    if (!map) return;
    if (!place) {
      pin.current?.remove();
      pin.current = null;
      return;
    }
    if (!pin.current) {
      pin.current = L.marker([place.lat, place.lon], { icon: pinIcon, draggable: true, keyboard: false }).addTo(map);
      pin.current.on("dragend", () => {
        const at = pin.current!.getLatLng();
        pick.current(at.lat, at.lng);
      });
    } else pin.current.setLatLng([place.lat, place.lon]);
    if (!map.getBounds().pad(-0.15).contains([place.lat, place.lon]) || map.getZoom() < 4)
      map.setView([place.lat, place.lon], Math.max(map.getZoom(), 9), { animate: false });
  }, [map, place]);

  return (
    <div
      className={cn("ss-map-picking relative", className)}
      role="application"
      aria-label="Map: click or drag the pin to set where the slide was taken"
    >
      <div ref={box} className="absolute inset-0" />
    </div>
  );
}
