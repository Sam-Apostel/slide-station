// Getting scans into the browser version: a folder picked with the File System Access picker
// (Chrome, Edge), a folder picked with <input webkitdirectory> (everywhere else), or a folder
// dropped on the page. Each becomes a source the import can read from (server.addSource).
import { inputFolder, pickedFolder, walk, type PickedFile } from "@/lib/files";
import { addSource, filesOf } from "./server";
import { canPickFolders, pickDirectory } from "./library";

/** Ask for a folder of scans; the source id to import from, or null when cancelled. */
export async function chooseFolder(): Promise<string | null> {
  if (canPickFolders) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await pickDirectory({ id: "scans", mode: "read", startIn: "pictures" });
    } catch {
      return null; // cancelled
    }
    return addSource(dir.name, await filesOf(dir), dir);
  }
  const files = await inputFolder();
  if (!files?.length) return null;
  const picked = pickedFolder(files);
  return addSource(picked.name, picked.files);
}

/**
 * A dropped folder (or loose JPEGs); the source id, or null if nothing usable was dropped. Call it
 * from the drop event itself: the browser takes the dropped items away once the handler returns.
 */
export function fromDrop(dt: DataTransfer): Promise<string | null> {
  const items = [...dt.items].filter((i) => i.kind === "file");
  // both must be asked for synchronously, inside the drop event
  type WithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  const handles = items.map((i) => (i as WithHandle).getAsFileSystemHandle?.() ?? Promise.resolve(null));
  const entries = items.map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  return (async () => {
    // Chrome and Edge hand out real directory handles: those can be cleaned later if it's a card
    const hs = await Promise.all(handles.map((p) => p.catch(() => null)));
    if (hs.length === 1 && hs[0]?.kind === "directory") {
      const dir = hs[0] as FileSystemDirectoryHandle;
      return addSource(dir.name, await filesOf(dir), dir);
    }
    const files: PickedFile[] = [];
    for (const e of entries) files.push(...(await walk(e, "")));
    if (!files.length) return null;
    const one = entries.length === 1 && entries[0].isDirectory;
    return addSource(
      one ? entries[0].name : "Dropped scans",
      files.map((f) => ({ ...f, path: one ? f.path.slice(entries[0].name.length + 1) : f.path })),
    );
  })();
}
