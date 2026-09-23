import * as React from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { ProTitlebar } from "@/components/ui/pro-titlebar";
import { ProButton, ProButtonGroup } from "@/components/ui/pro-button";
import { Tip } from "@/components/tip";
import { desktop, isMac } from "@/lib/desktop";

/** Shows / hides the filmstrip and the inspector, like the layout toggles in ProUI's app shells. */
export function PanelToggles({
  filmstrip,
  inspector,
  onFilmstrip,
  onInspector,
}: {
  filmstrip: boolean;
  inspector: boolean;
  onFilmstrip: () => void;
  onInspector: () => void;
}) {
  const mod = isMac ? "⌥⌘" : "Ctrl+Alt+";
  return (
    <ProButtonGroup>
      <Tip label={`${filmstrip ? "Hide" : "Show"} filmstrip`} keys={`${mod}1`}>
        <ProButton
          plain
          aria-label="Filmstrip"
          aria-pressed={filmstrip}
          data-on={filmstrip || undefined}
          onClick={onFilmstrip}
        >
          <PanelLeft />
        </ProButton>
      </Tip>
      <Tip label={`${inspector ? "Hide" : "Show"} inspector`} keys={`${mod}2`}>
        <ProButton
          plain
          aria-label="Inspector"
          aria-pressed={inspector}
          data-on={inspector || undefined}
          onClick={onInspector}
        >
          <PanelRight />
        </ProButton>
      </Tip>
    </ProButtonGroup>
  );
}

function useFullscreen() {
  const [fullscreen, setFullscreen] = React.useState(false);
  React.useEffect(() => desktop?.onWindow((s) => setFullscreen(s.fullscreen)), []);
  return fullscreen;
}

/**
 * The window's top edge in the desktop app, and its only bar: ProTitlebar as ProUI intends it for
 * Electron — the bar is the drag region, the OS draws the real window controls
 * (`trafficLights={false}` with room left for them on macOS, the caption-button overlay on the
 * right elsewhere), and controls opt out of dragging through `pro-no-drag` (ProButton does that
 * itself). The tray switcher names the window, so there is no separate title.
 */
export function WindowTitlebar({
  title,
  left,
  center,
  right,
}: {
  title: string;
  left?: React.ReactNode;
  center?: React.ReactNode;
  right?: React.ReactNode;
}) {
  const fullscreen = useFullscreen();
  return (
    <ProTitlebar
      // the left slot grows to hold the activity well, centred in the space between the two ends
      className="ss-titlebar h-[44px] gap-2 [&_.pro-titlebar-left]:min-w-0 [&_.pro-titlebar-left]:flex-1"
      trafficLights={false}
      title={<span className="sr-only">{title}</span>}
      left={
        <>
          {/* macOS traffic lights sit over this spacer (see trafficLightPosition in desktop/main.cjs) */}
          {isMac && !fullscreen ? <span className="block w-[64px] shrink-0" /> : <AppMark />}
          {left}
          <div className="pro-drag flex h-full min-w-0 flex-1 items-center justify-center px-2">
            <div className="pro-no-drag flex max-w-[440px] min-w-0 justify-center">{center}</div>
          </div>
        </>
      }
      right={
        // Windows / Linux draw their caption buttons over the right 140 px of the bar.
        <div className={isMac ? "flex items-center gap-2" : "mr-[140px] flex items-center gap-2"}>{right}</div>
      }
    />
  );
}

export function AppMark() {
  return (
    <span aria-hidden className="relative block size-[16px] rounded-[3px] bg-primary">
      <span className="absolute inset-x-[4px] inset-y-[4px] rounded-[1px] bg-(--ss-ink)" />
    </span>
  );
}
