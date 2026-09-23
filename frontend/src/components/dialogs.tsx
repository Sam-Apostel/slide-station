import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { desktop, isMac } from "@/lib/desktop";
import { api, sourceLabel, type AppState, type Config, type Source } from "@/lib/api";
import { cn } from "@/lib/utils";

const primary = "bg-primary text-primary-foreground";

/** A path field; in the desktop app it gets a native “Choose…” folder picker next to it. */
function FolderInput({
  id,
  value,
  onChange,
  placeholder,
  pickerTitle,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  pickerTitle: string;
}) {
  const input = <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
  if (!desktop) return input;
  const pick = async () => {
    const p = await desktop!.pickFolder({ title: pickerTitle, defaultPath: value || undefined });
    if (p) onChange(p);
  };
  return (
    <div className="flex gap-1.5">
      <div className="min-w-0 flex-1">{input}</div>
      <Button type="button" onClick={pick}>
        Choose…
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ settings

export function SettingsDialog({
  open,
  onOpenChange,
  config,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config | undefined;
  onSaved: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [key, setKey] = React.useState("");
  const [library, setLibrary] = React.useState("");
  const [keepOriginals, setKeepOriginals] = React.useState(true);
  const [keepExports, setKeepExports] = React.useState(false);
  const [test, setTest] = React.useState<{ ok?: boolean; message: string } | null>(null);

  React.useEffect(() => {
    if (!open || !config) return;
    setUrl(config.immich_url || "");
    setKey("");
    setLibrary(config.library);
    setKeepOriginals(config.keep_originals);
    setKeepExports(config.keep_exports);
    setTest(null);
    // only when the dialog opens; config is a new object on every poll
  }, [open]);

  const runTest = async () => {
    setTest({ message: "Testing…" });
    try {
      setTest(await api("POST", "/api/immich/test", { immich_url: url, immich_key: key }));
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/api/config", {
        immich_url: url.trim(),
        immich_key: key.trim(),
        library: library.trim(),
        keep_originals: keepOriginals,
        keep_exports: keepExports,
      });
      toast.success("Settings saved");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={save} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="cfg-url">Immich server URL</FieldLabel>
              <Input
                id="cfg-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://your-server:2283"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cfg-key">Immich API key</FieldLabel>
              <Input
                id="cfg-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={config?.has_key ? "saved — leave empty to keep it" : "paste your API key"}
              />
              <FieldDescription>
                Create one in Immich → Account settings → API keys. It needs: asset.upload, asset.delete, album.read,
                album.create, albumAsset.create.
              </FieldDescription>
            </Field>
            <div className="flex items-center gap-3">
              <Button type="button" onClick={runTest}>
                Test connection
              </Button>
              {test && (
                <span
                  role="status"
                  className={cn(
                    "text-[12px]",
                    test.ok === true && "text-[var(--pro-green)]",
                    test.ok === false && "text-destructive",
                  )}
                >
                  {test.message}
                </span>
              )}
            </div>
            <Field>
              <FieldLabel htmlFor="cfg-lib">Library folder</FieldLabel>
              <FolderInput id="cfg-lib" value={library} onChange={setLibrary} pickerTitle="Library folder" />
              <FieldDescription>
                Originals, previews and finished JPEGs live here. With the defaults that's about 6 MB per slide (60 GB
                for 10,000), so an external drive is a good home.
              </FieldDescription>
            </Field>
            <CheckRow id="cfg-keep" checked={keepOriginals} onChange={setKeepOriginals}>
              Keep original scans after upload (safest, ~5 MB per slide)
            </CheckRow>
            <CheckRow id="cfg-keep-exp" checked={keepExports} onChange={setKeepExports}>
              Also keep the finished JPEGs locally (~6 MB per slide)
            </CheckRow>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className={primary}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CheckRow({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="text-[12px] font-normal">
        {children}
      </Label>
    </div>
  );
}

// ------------------------------------------------------------------ new tray

const FOLDER = "__folder";
const NOTHING = "__none";

export function NewTrayDialog({
  open,
  onOpenChange,
  state,
  preferSource,
  preferFolder,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AppState | null;
  preferSource?: Source;
  /** Opened from a dropped or picked folder: import that. */
  preferFolder?: string;
  onCreate: (body: { name: string; album: string; date: string }, source: string) => void;
}) {
  const sources = (state?.sources ?? []).filter((x) => x.count > 0);
  const [name, setName] = React.useState("");
  const [album, setAlbum] = React.useState("");
  const [date, setDate] = React.useState("");
  const [source, setSource] = React.useState(NOTHING);
  const [folder, setFolder] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setAlbum("");
    setDate("");
    setFolder(preferFolder ?? "");
    setSource(preferFolder !== undefined ? FOLDER : (preferSource?.path ?? sources[0]?.path ?? NOTHING));
    // only when the dialog opens; the source list refreshes every poll
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const src = source === FOLDER ? folder.trim() : source === NOTHING ? "" : source;
    onOpenChange(false);
    onCreate(
      { name: name.trim() || `Tray ${new Date().toLocaleDateString()}`, album: album.trim(), date: date.trim() },
      src,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <form onSubmit={submit} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>New tray</DialogTitle>
            <DialogDescription>One tray of slides becomes one Immich album.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="n-name">Name</FieldLabel>
              <Input
                id="n-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Box 3 – tray 2"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="n-album">Immich album</FieldLabel>
              <Input id="n-album" value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="same as name" />
            </Field>
            <Field>
              <FieldLabel htmlFor="n-date">Photo date</FieldLabel>
              <Input
                id="n-date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="optional, e.g. 1985-07"
              />
              <FieldDescription>
                The date is written into every photo so Immich files them in the right year. Leave it empty to keep the
                scanner's own date.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="n-source">Import from</FieldLabel>
              <NativeSelect id="n-source" className="w-full" value={source} onChange={(e) => setSource(e.target.value)}>
                {sources.map((x) => (
                  <NativeSelectOption key={x.path} value={x.path}>
                    {sourceLabel(x)} ({x.new} new of {x.count})
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value={FOLDER}>A folder on this Mac…</NativeSelectOption>
                <NativeSelectOption value={NOTHING}>Nothing yet</NativeSelectOption>
              </NativeSelect>
            </Field>
            {source === FOLDER && (
              <Field>
                <FieldLabel htmlFor="n-path">Folder path</FieldLabel>
                <FolderInput
                  id="n-path"
                  value={folder}
                  onChange={setFolder}
                  placeholder="/Users/you/Pictures/slides/box 4"
                  pickerTitle="Import scans from a folder"
                />
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className={primary}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ keyboard help

export const SHORTCUTS: [React.ReactNode, string][] = [
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd>
    </>,
    "Previous / next slide",
  ],
  [<Kbd>Space</Kbd>, "Develop (mark ready for Immich), go to next"],
  [
    <>
      <Kbd>R</Kbd> / <Kbd>⇧ R</Kbd>
    </>,
    "Rotate right / left",
  ],
  [
    <>
      <Kbd>B</Kbd> (hold)
    </>,
    "Show before",
  ],
  [<Kbd>C</Kbd>, "Copy colour from previous slide"],
  [<Kbd>0</Kbd>, "Reset colour"],
  [<Kbd>F</Kbd>, "Fit the tone curves to the scan's data"],
  [<Kbd>⇧ F</Kbd>, "Fit the curves of every slide still to develop"],
  [<Kbd>X</Kbd>, "Skip slide (not uploaded)"],
  [<Kbd>M</Kbd>, "Merge with next slide"],
  [
    <>
      <Kbd>1</Kbd>–<Kbd>9</Kbd>
    </>,
    "Toggle scan in the stack",
  ],
  [<Kbd>{isMac ? "⌘ K" : "Ctrl K"}</Kbd>, "Every action, searchable"],
  ["Right-click", "Actions for a slide"],
  [<Kbd>?</Kbd>, "This list"],
];

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
        </DialogHeader>
        <table className="w-full text-[12px]">
          <tbody>
            {SHORTCUTS.map(([keys, what], i) => (
              <tr key={i} className="border-b border-(--ss-line-soft) last:border-0">
                <td className="py-1.5 pr-4 whitespace-nowrap">{keys}</td>
                <td className="py-1.5 text-foreground/75">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <DialogFooter>
          <DialogClose asChild>
            <Button className={primary}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
