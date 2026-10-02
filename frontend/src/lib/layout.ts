import * as React from "react";
import { desktop } from "@/lib/desktop";

/**
 * Which layout fits the window:
 * - "wide": filmstrip | stage | inspector side by side (they need about 780 px together);
 * - "portrait": a phone held upright (or any narrow window): the photo on top, the tools under it;
 * - "landscape": a phone on its side (wide but short): the photo full height, the tools in a rail.
 * The desktop app always gets "wide": its window has a minimum size.
 */
export type Layout = "wide" | "portrait" | "landscape";

function pick(w: number, h: number): Layout {
  if (desktop) return "wide";
  if (w > h && h < 560 && w < 1180) return "landscape";
  if (w < 800) return "portrait";
  return "wide";
}

const current = () => (typeof window === "undefined" ? "wide" : pick(window.innerWidth, window.innerHeight));

/** The layout for the window's size, following resizes and turning the phone. Also mirrored on
 *  `<html data-layout>` (and `data-compact` for both phone layouts), which theme.css sizes the
 *  controls by: dialogs and menus are portalled outside the app, so a class on it wouldn't reach. */
export function useLayout(): Layout {
  const [layout, setLayout] = React.useState<Layout>(current);
  React.useEffect(() => {
    const update = () => setLayout(current());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.layout = layout;
    if (layout === "wide") delete root.dataset.compact;
    else root.dataset.compact = "";
  }, [layout]);
  return layout;
}
