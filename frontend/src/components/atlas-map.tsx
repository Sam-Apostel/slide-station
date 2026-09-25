// The map in People & Places: one dot per place, sized by its slides (Leaflet). The tiles are
// OpenStreetMap's own (no key; fine for one person's light use under its tile policy, credited),
// darkened in theme.css to sit with the app. The dots need nothing from the network, so offline the
// places still show, on a blank background.
import * as React from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AtlasPlace } from "@/lib/api";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const AMBER = "#f2b34b";

export function AtlasMap({
  places,
  selected,
  onSelect,
  className,
}: {
  /** The places to show (already filtered to a person, when one is picked). */
  places: (AtlasPlace & { count: number })[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  className?: string;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<L.Map | null>(null);
  const layer = React.useRef<L.LayerGroup | null>(null);
  const select = React.useRef(onSelect);
  select.current = onSelect;

  React.useEffect(() => {
    const m = L.map(box.current!, { worldCopyJump: true, zoomControl: true, attributionControl: true }).setView(
      [30, 10],
      2,
    );
    L.tileLayer(TILES, { attribution: CREDIT, maxZoom: 19, className: "ss-map-tiles" }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on("click", () => select.current(null));
    map.current = m;
    // the dialog animates open: measure again once it has its size
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current!);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  // fit the view to the places whenever the set changes (a person picked), not on every selection
  const ids = places.map((p) => p.id).join("|");
  React.useEffect(() => {
    const m = map.current;
    if (!m || !places.length) return;
    const bounds = L.latLngBounds(places.map((p) => [p.lat, p.lon] as [number, number]));
    m.fitBounds(bounds.pad(0.3), { maxZoom: 9, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

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
        select.current(p.id);
      });
      c.addTo(g);
    }
  }, [places, selected]);

  return <div ref={box} className={className} role="application" aria-label="Map of the places on your slides" />;
}
