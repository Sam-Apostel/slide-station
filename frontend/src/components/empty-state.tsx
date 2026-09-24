import { FolderInput, HardDriveDownload, Images } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { plural, sourceLabel, standalone, type Source } from "@/lib/api";

const STEPS = [
  <>
    Plug in the Slide N Scan and switch it to <b>USB mode</b>. It shows up here within a few seconds.
  </>,
  <>Import into a tray. Brackets are grouped, blended and turned upright automatically.</>,
  <>Step through the slides with the arrow keys and fix anything the auto-restore got wrong.</>,
  <>Upload to Immich, then clean the card.</>,
];

// The browser version: no scanner detection and nothing to install.
const WEB_STEPS = [
  <>
    Drop a folder of scans on this window (the scanner's card, or any folder of JPEGs), or choose one. Everything
    happens <b>in this browser</b>: nothing is uploaded anywhere until you send it to Immich.
  </>,
  <>Scans of the same slide are grouped and blended, turned upright and restored automatically.</>,
  <>Step through the slides with the arrow keys and fix anything the auto-restore got wrong.</>,
  <>Send them to your Immich, or save the finished JPEGs to disk.</>,
];

export function EmptyState({
  source,
  onImport,
  onImportFolder,
}: {
  source: Source | undefined;
  onImport: (src: Source) => void;
  onImportFolder: () => void;
}) {
  return (
    <div className="grid flex-1 place-items-center bg-[var(--pro-canvas)] p-6">
      <Empty className="max-w-[520px] flex-none rounded-[12px] border border-solid border-border bg-(--ss-panel) px-8 py-8 shadow-[0_16px_60px_#0005]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Images />
          </EmptyMedia>
          <EmptyTitle className="text-[18px]">Scan, review, upload</EmptyTitle>
          <EmptyDescription>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-left leading-relaxed text-muted-foreground [&_b]:text-foreground/90">
              {(standalone ? WEB_STEPS : STEPS).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {standalone && !source ? (
            <Button className="bg-primary text-primary-foreground" onClick={onImportFolder}>
              <FolderInput /> Choose a folder of scans
            </Button>
          ) : source ? (
            <Button className="bg-primary text-primary-foreground" onClick={() => onImport(source)}>
              <HardDriveDownload />
              Import {plural(source.new, "scan")} from {source.scanner ? "the Slide N Scan" : sourceLabel(source)}
            </Button>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              Waiting for the scanner… or
              <Button onClick={onImportFolder}>
                <FolderInput /> import a folder
              </Button>
            </div>
          )}
        </EmptyContent>
      </Empty>
    </div>
  );
}
