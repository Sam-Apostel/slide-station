// Folders of scans from the browser: a folder picked with <input webkitdirectory>, or dropped on the
// page. Shared by the browser version (standalone/pick.ts) and uploads to a server (lib/upload.ts).

export type PickedFile = { file: File; path: string };

/** Ask for a folder with the file input; its files, or null when cancelled. */
export function inputFolder(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.onchange = () => resolve(input.files ? [...input.files] : null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** A picked folder's files with their paths inside it, and the folder's name. */
export function pickedFolder(files: File[]): { name: string; files: PickedFile[] } {
  const name = files[0]?.webkitRelativePath.split("/")[0] || "Folder";
  return {
    name,
    files: files.map((file) => ({ file, path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name })),
  };
}

/** Every file under a dropped entry, with its path from the entry's parent. */
export async function walk(e: FileSystemEntry, prefix: string): Promise<PickedFile[]> {
  if (e.isFile) {
    const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
    return [{ file, path: prefix + e.name }];
  }
  const reader = (e as FileSystemDirectoryEntry).createReader();
  const out: PickedFile[] = [];
  // readEntries hands out at most 100 at a time
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const c of batch) if (!c.name.startsWith(".")) out.push(...(await walk(c, `${prefix}${e.name}/`)));
  }
  return out;
}

/**
 * What was dropped: one folder (its name, files relative to it) or loose files ("Dropped scans").
 * Call it from the drop event itself: the entries have to be asked for before the handler returns.
 */
export function droppedFiles(dt: DataTransfer): Promise<{ name: string; files: PickedFile[] } | null> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => !!e);
  return (async () => {
    const files: PickedFile[] = [];
    for (const e of entries) files.push(...(await walk(e, "")));
    if (!files.length) return null;
    const one = entries.length === 1 && entries[0].isDirectory;
    return {
      name: one ? entries[0].name : "Dropped scans",
      files: files.map((f) => ({ ...f, path: one ? f.path.slice(entries[0].name.length + 1) : f.path })),
    };
  })();
}
