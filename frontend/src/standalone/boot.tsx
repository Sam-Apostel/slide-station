// Start-up for the browser version: find the library before the app loads. A folder on disk
// picked earlier needs one click to be allowed again (browsers ask per visit); otherwise the
// browser's own storage, or — where there is none — a tab-only library.
import * as React from "react";
import { FolderOpen, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  browserLibrary,
  canPickFolders,
  handleLibrary,
  kvGet,
  kvSet,
  memoryLibrary,
  permission,
  pickDirectory,
  type Library,
} from "./library";
import { changeLibrary, setLibrary } from "./server";

const KEY = "library";

async function fallback(): Promise<Library> {
  return (await browserLibrary()) ?? memoryLibrary();
}

/** Pick a folder on disk for the library (Chrome, Edge); null when cancelled. */
export async function chooseLibraryFolder(): Promise<Library | null> {
  try {
    const dir = await pickDirectory({ id: "library", mode: "readwrite", startIn: "pictures" });
    await kvSet(KEY, dir);
    const lib = handleLibrary(dir, "disk");
    changeLibrary(lib);
    return lib;
  } catch {
    return null;
  }
}

/** Back to the browser's own storage. */
export async function switchToBrowserStorage(): Promise<Library> {
  await kvSet(KEY, undefined);
  const lib = await fallback();
  changeLibrary(lib);
  return lib;
}

export function LibraryGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ ready: boolean; waiting?: FileSystemDirectoryHandle; generation: number }>(
    {
      ready: false,
      generation: 0,
    },
  );
  const ready = (lib: Library) => {
    // a later switch of library (Settings) remounts the app on the new one
    setLibrary(lib, () => setState((x) => ({ ...x, generation: x.generation + 1 })));
    setState((s) => ({ ready: true, generation: s.generation + 1 }));
  };

  React.useEffect(() => {
    (async () => {
      const dir = canPickFolders ? await kvGet<FileSystemDirectoryHandle>(KEY) : undefined;
      if (!dir) return ready(await fallback());
      const p = await permission(dir, "readwrite", false).catch(() => "denied" as PermissionState);
      if (p === "granted") return ready(handleLibrary(dir, "disk"));
      setState((s) => ({ ...s, waiting: dir }));
    })();
  }, []);

  if (state.ready) return <React.Fragment key={state.generation}>{children}</React.Fragment>;
  if (!state.waiting) return null;
  const dir = state.waiting;
  const reopen = async () => {
    if ((await permission(dir, "readwrite", true).catch(() => "denied")) === "granted")
      ready(handleLibrary(dir, "disk"));
  };
  return (
    <div className="grid h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="max-w-[440px] rounded-[12px] border border-border bg-(--ss-panel) p-8 text-center shadow-[0_16px_60px_#0005]">
        <img src="./favicon.svg" alt="" aria-hidden className="mx-auto mb-4 size-10" />
        <h1 className="text-[18px] font-semibold">Slide Station</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Your library is the folder <b className="text-foreground">“{dir.name}”</b>. The browser asks once per visit
          before a page may use a folder on your disk.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button className="bg-primary text-primary-foreground" onClick={reopen} autoFocus>
            <FolderOpen /> Open “{dir.name}”
          </Button>
          <Button
            variant="outline"
            onClick={async () => ready(await (async () => (await kvSet(KEY, undefined), fallback()))())}
          >
            <HardDrive /> Use this browser's storage instead
          </Button>
        </div>
      </div>
    </div>
  );
}
