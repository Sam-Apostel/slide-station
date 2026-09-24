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
import {
  api,
  plural,
  sourceLabel,
  SIGNED_OUT,
  standalone,
  type AppState,
  type AuthState,
  type Config,
  type Group,
  type InsightsState,
  type Source,
} from "@/lib/api";
import type { Stats } from "@/lib/stats";
import { WatchedFolders } from "@/components/watch";
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

const gb = (n: number) =>
  n >= 1e8 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`;

export function SettingsDialog({
  open,
  onOpenChange,
  config,
  quota,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config | undefined;
  /** Room used and allowed, when the server sets quotas. */
  quota?: AppState["quota"];
  onSaved: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [key, setKey] = React.useState("");
  const [library, setLibrary] = React.useState("");
  const [keepOriginals, setKeepOriginals] = React.useState(true);
  const [keepExports, setKeepExports] = React.useState(false);
  const [stackOriginals, setStackOriginals] = React.useState(false);
  const [learning, setLearning] = React.useState(true);
  const [people, setPeople] = React.useState(false);
  const [learned, setLearned] = React.useState<{ examples: number; min_examples: number } | null>(null);
  const [suggestTags, setSuggestTags] = React.useState(false);
  const [lookalikes, setLookalikes] = React.useState(false);
  const [openEyes, setOpenEyes] = React.useState(false);
  const [suggestCaptions, setSuggestCaptions] = React.useState(false);
  const [insights, setInsights] = React.useState<InsightsState | null>(null);
  const [test, setTest] = React.useState<{ ok?: boolean; message: string } | null>(null);
  // a hosted server: signed in with an Immich API key, the library and Immich are the server's
  const [auth, setAuth] = React.useState<AuthState | null>(null);
  const hosted = !!auth?.accounts;

  React.useEffect(() => {
    if (!open || !config) return;
    if (!standalone) api<AuthState>("GET", "/api/auth").then(setAuth, () => setAuth(null));
    setUrl(config.immich_url || "");
    setKey("");
    setLibrary(config.library);
    setKeepOriginals(config.keep_originals);
    setKeepExports(config.keep_exports);
    setStackOriginals(!!config.upload_originals_stacked);
    setLearning(config.learning_enabled ?? true);
    setPeople(!!config.people_enabled);
    api<{ examples: number; min_examples: number }>("GET", "/api/learning").then(setLearned, () => setLearned(null));
    setSuggestTags(config.insights_enabled ?? false);
    setLookalikes(!!config.lookalike_enabled);
    setOpenEyes(!!config.eyes_enabled);
    setSuggestCaptions(config.captions_enabled ?? false);
    api<InsightsState>("GET", "/api/insights").then(setInsights, () => setInsights(null));
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
        upload_originals_stacked: stackOriginals,
        learning_enabled: learning,
        insights_enabled: suggestTags,
        lookalike_enabled: lookalikes,
        eyes_enabled: openEyes,
        ...(standalone ? {} : { captions_enabled: suggestCaptions }), // captions: the desktop app only
        people_enabled: people,
      });
      // turning tags / captions on fetches their models (one job in the activity pill); while another
      // job runs, the Insights section offers the download instead
      const models = [
        ...(suggestTags && !insights?.ready ? ["tags"] : []),
        ...(suggestCaptions && !insights?.captions.ready ? ["captions"] : []),
        ...(suggestTags && openEyes && !insights?.eyes?.ready ? ["eyes"] : []),
      ];
      if (models.length && !insights?.downloading) await api("POST", "/api/insights/model", { models }).catch(() => {});
      toast.success("Settings saved");
      if (people && !config?.people_enabled) {
        // turned on: fetch the face model and look for faces on the slides already in the library
        await api("POST", "/api/people/scan").then(
          () => toast("Looking for faces on your slides — see People when it's done"),
          (err) => toast.error(err instanceof Error ? err.message : String(err)),
        );
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto scrollbar-thin sm:max-w-[480px]">
        <form onSubmit={save} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <FieldGroup className="gap-4">
            {auth?.user && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">
                  Signed in as <b className="text-foreground/90">{auth.user.name || auth.user.email}</b>
                  {auth.user.name && auth.user.email ? ` (${auth.user.email})` : ""}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await api("POST", "/api/auth/logout").catch(() => {});
                    onOpenChange(false);
                    window.dispatchEvent(new Event(SIGNED_OUT));
                  }}
                >
                  Sign out
                </Button>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="cfg-url">Immich server URL</FieldLabel>
              <Input
                id="cfg-url"
                value={url}
                readOnly={hosted}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://your-server:2283"
              />
              {hosted && <FieldDescription>Set by this Slide Station server: your account is on it.</FieldDescription>}
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
                album.create, albumAsset.create. For the round trip also asset.read, asset.update (dates and captions in
                place), asset.view and asset.download (pulling photos back in), albumAsset.delete and stack.read /
                create / delete.
                {" To send tags and the names of the people on the slides: tag.create and tag.asset."}
                {standalone && (
                  <>
                    {" "}
                    It is kept in this browser only. Immich has to accept requests from this page: serve Slide Station
                    from Immich's own address, or let its reverse proxy allow {location.origin} (CORS).
                  </>
                )}
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
            {standalone ? (
              <BrowserLibrary config={config} />
            ) : hosted ? (
              <Field>
                <FieldLabel>Library</FieldLabel>
                <FieldDescription>
                  Your trays live on this server, in a library of your own that nobody else signed in here can see.
                  {quota?.library && ` It holds ${gb(quota.library.used)} of the ${gb(quota.library.limit)} it may.`}
                  {quota?.uploads &&
                    ` Folders waiting to be imported take ${gb(quota.uploads.used)} of ${gb(quota.uploads.limit)}.`}
                </FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="cfg-lib">Library folder</FieldLabel>
                <FolderInput id="cfg-lib" value={library} onChange={setLibrary} pickerTitle="Library folder" />
                <FieldDescription>
                  Originals, previews and finished JPEGs live here. With the defaults that's about 6 MB per slide (60 GB
                  for 10,000), so an external drive is a good home.
                </FieldDescription>
              </Field>
            )}
            {/* the browser version reads a folder itself (its picker); a server watches paths */}
            {!standalone && <WatchedFolders />}
            <CheckRow id="cfg-keep" checked={keepOriginals} onChange={setKeepOriginals}>
              Keep original scans after upload (safest, ~5 MB per slide)
            </CheckRow>
            <CheckRow id="cfg-keep-exp" checked={keepExports} onChange={setKeepExports}>
              Also keep the finished JPEGs locally (~6 MB per slide)
            </CheckRow>
            <Field>
              <CheckRow id="cfg-stack" checked={stackOriginals} onChange={setStackOriginals}>
                Upload the untouched scans too, stacked under each slide in Immich
              </CheckRow>
              <FieldDescription>
                Nothing is ever lost: Immich shows the developed photo, its scans sit in the stack behind it (~5 MB per
                scan). Needs Immich with stacks and the stack.read / stack.create permissions.
              </FieldDescription>
            </Field>
            <Field>
              <CheckRow id="cfg-learn" checked={learning} onChange={setLearning}>
                Learn from my edits and suggest settings for new slides
              </CheckRow>
              <FieldDescription className="flex items-center gap-2">
                <span className="flex-1">
                  {!learned
                    ? "Every developed slide becomes an example."
                    : learned.examples < learned.min_examples
                      ? `${learned.examples} of ${learned.min_examples} developed slides needed before it suggests anything.`
                      : `Learned from ${learned.examples} developed slides.`}
                </span>
                {!!learned?.examples && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await api("POST", "/api/learning/reset");
                      setLearned({ ...learned, examples: 0 });
                      toast("Forgot everything it learned");
                    }}
                  >
                    Forget
                  </Button>
                )}
              </FieldDescription>
            </Field>
            <Field>
              <CheckRow id="cfg-insights" checked={suggestTags} onChange={setSuggestTags}>
                Suggest tags (downloads a ~{insights?.model_mb ?? 155} MB model)
              </CheckRow>
              <FieldDescription>
                Recognises scenes (beach, snow, wedding, dog…) {standalone ? "in this browser" : "on this computer"}, in
                the background, and shows them as suggestions under Insights; nothing changes until you accept. Accepted
                tags go to Immich as tags (the API key then also needs tag.create and tag.asset).
                {insights?.ready
                  ? " The model is downloaded."
                  : insights?.downloading
                    ? " Downloading the model…"
                    : ""}{" "}
                The same model points out slides that look like the same shot, brackets that may be two slides, and the
                scenes of a tray.
                {standalone &&
                  " The model is kept in the library, so a library folder on disk shares it with the desktop app."}
              </FieldDescription>
            </Field>
            {suggestTags && (
              <Field>
                <CheckRow id="cfg-lookalike" checked={lookalikes} onChange={setLookalikes}>
                  After uploading, look for photos in Immich that look like the new slides
                </CheckRow>
                <FieldDescription>
                  Finds a slide you scanned before (say with another tool, years ago) and offers to replace it. Uses
                  Immich's search by image where it has one (asset.read), else the photos taken around the slide's date;
                  the thumbnails are compared {standalone ? "in this browser" : "on this computer"} (asset.view).
                </FieldDescription>
              </Field>
            )}
            {suggestTags && (
              <Field>
                <CheckRow id="cfg-eyes" checked={openEyes} onChange={setOpenEyes}>
                  Prefer the shot with open eyes (downloads a ~{insights?.eyes?.model_mb ?? 5} MB face model)
                </CheckRow>
                <FieldDescription>
                  When slides look like the same shot, the one to keep is the sharpest where nobody blinked; the card
                  says on which slides eyes are closed.
                  {insights?.eyes?.ready ? " The model is downloaded." : ""}
                </FieldDescription>
              </Field>
            )}
            {!standalone && (
              <Field>
                <CheckRow id="cfg-captions" checked={suggestCaptions} onChange={setSuggestCaptions}>
                  Suggest captions (downloads a ~{insights?.captions.model_mb ?? 276} MB model)
                </CheckRow>
                <FieldDescription>
                  Writes a short description of each slide (“A red car parked in front of a house.”) on this computer,
                  in the background, a few seconds a slide. Shown under Insights to edit and accept; it becomes the
                  slide's caption, which Immich shows as the description. Never replaces a caption you typed.
                  {insights?.captions.ready
                    ? " The model is downloaded."
                    : insights?.downloading
                      ? " Downloading…"
                      : ""}
                </FieldDescription>
              </Field>
            )}
            <Field>
              <CheckRow id="cfg-people" checked={people} onChange={setPeople}>
                Recognise people across my slides
              </CheckRow>
              <FieldDescription>
                Groups the faces on your slides by person, so you can name each person once; Immich gets the names as
                tags. Downloads a 39 MB face model once. Everything stays{" "}
                {standalone ? "in this browser" : "on this computer"}.
              </FieldDescription>
            </Field>
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

/** Browser version: where the library lives, and moving it to a folder on disk (Chrome, Edge). */
function BrowserLibrary({ config }: { config: Config | undefined }) {
  const canPick = "showDirectoryPicker" in window;
  const where =
    config?.storage === "disk"
      ? `The folder “${config.library}” on your disk.`
      : config?.storage === "browser"
        ? "This browser's own storage, on this computer. Clearing the site's data deletes it."
        : "This tab only: nothing is kept when you close it.";
  const choose = async () => {
    const boot = await import("@/standalone/boot");
    if (await boot.chooseLibraryFolder()) toast.success("Library moved to the folder you picked");
  };
  const browser = async () => {
    const boot = await import("@/standalone/boot");
    await boot.switchToBrowserStorage();
    toast.success("Using this browser's storage");
  };
  return (
    <Field>
      <FieldLabel>Library</FieldLabel>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px]">{where}</span>
        {canPick && (
          <Button type="button" onClick={choose}>
            Choose folder…
          </Button>
        )}
        {config?.storage === "disk" && (
          <Button type="button" variant="outline" onClick={browser}>
            Use browser
          </Button>
        )}
      </div>
      <FieldDescription>
        Originals, previews and finished JPEGs live here, about 6 MB per slide.{" "}
        {canPick
          ? "A folder on disk has the same layout as the desktop app's library, so either app can open it."
          : "To keep the library in a folder on disk, use Chrome or Edge (or the desktop app)."}{" "}
        Trays already in one place stay there when you switch.
      </FieldDescription>
    </Field>
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
  onChooseFolder,
  onFromImmich,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AppState | null;
  preferSource?: Source;
  /** Opened from a dropped or picked folder: import that. */
  preferFolder?: string;
  onCreate: (body: { name: string; album: string; date: string }, source: string) => void;
  /** Browser version: pick a folder of scans to import (resolves to the new source). */
  onChooseFolder?: () => Promise<Source | null>;
  /** Start a tray from photos already in Immich instead. */
  onFromImmich?: () => void;
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
              <div className="flex gap-1.5">
                <NativeSelect
                  id="n-source"
                  className="w-full min-w-0 flex-1"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  {sources.map((x) => (
                    <NativeSelectOption key={x.path} value={x.path}>
                      {sourceLabel(x)} ({x.new} new of {x.count})
                    </NativeSelectOption>
                  ))}
                  {!standalone && !state?.server?.accounts && (
                    <NativeSelectOption value={FOLDER}>A folder on this Mac…</NativeSelectOption>
                  )}
                  <NativeSelectOption value={NOTHING}>Nothing yet</NativeSelectOption>
                </NativeSelect>
                {onChooseFolder && (
                  <Button
                    type="button"
                    onClick={async () => {
                      const src = await onChooseFolder();
                      if (src) setSource(src.path);
                    }}
                  >
                    Choose folder…
                  </Button>
                )}
              </div>
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
            {onFromImmich && (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                onClick={() => {
                  onOpenChange(false);
                  onFromImmich();
                }}
              >
                From Immich…
              </Button>
            )}
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

// ------------------------------------------------------------------ date a range

/** Where a run of slides dated from `sel` naturally ends: before the next slide with its own date. */
export function rangeEnd(groups: Group[], sel: number) {
  const next = groups.findIndex((g, i) => i > sel && g.date);
  return next >= 0 ? next - 1 : groups.length - 1;
}

/**
 * Date a run of slides at once ("12–31: Aug 1978"). Slide numbers are 1-based as in the filmstrip;
 * it opens on this slide through the one before the next dated slide (or the end of the tray).
 */
export function DateRangeDialog({
  open,
  onOpenChange,
  groups,
  sel,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Group[];
  sel: number;
  onApply: (fromIndex: number, toIndex: number, date: string) => Promise<boolean>;
}) {
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [date, setDate] = React.useState("");
  const n = groups.length;

  React.useEffect(() => {
    if (!open) return;
    setFrom(String(sel + 1));
    setTo(String(rangeEnd(groups, sel) + 1));
    setDate(groups[sel]?.date ?? "");
    // only when the dialog opens; the groups refresh on every edit
  }, [open]);

  const a = Number(from);
  const b = Number(to);
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= 1 && a <= n && b <= n;
  const count = valid ? Math.abs(b - a) + 1 : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (valid && (await onApply(a - 1, b - 1, date.trim()))) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <form onSubmit={submit} className="grid gap-[18px]">
          <DialogHeader>
            <DialogTitle>Date a range of slides</DialogTitle>
            <DialogDescription>
              Every slide in the range gets this date as its own. Leave the date empty to clear theirs.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="dr-from">From slide</FieldLabel>
                <Input
                  id="dr-from"
                  inputMode="numeric"
                  value={from}
                  onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dr-to">To slide</FieldLabel>
                <Input
                  id="dr-to"
                  inputMode="numeric"
                  value={to}
                  onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="dr-date">Date</FieldLabel>
              <Input
                id="dr-date"
                autoFocus
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="1978, 1978-08 or 1978-08-14"
              />
              <FieldDescription>
                {valid
                  ? `${count === 1 ? "1 slide" : `${count} slides`} of ${n}. Locked slides keep their date.`
                  : `Slide numbers go from 1 to ${n}.`}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" className={primary} disabled={!valid}>
              {date.trim() ? "Date slides" : "Clear dates"}
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
  [<Kbd>H</Kbd>, "Mirror (scanned the wrong way round)"],
  [
    <>
      <Kbd>B</Kbd> (hold)
    </>,
    "Show before",
  ],
  [<Kbd>Y</Kbd>, "Split view: before | after (drag the divider)"],
  [
    <>
      <Kbd>Z</Kbd> / double-click
    </>,
    "1:1 zoom on the full-resolution render (drag to move, Z or Esc to leave)",
  ],
  [<Kbd>L</Kbd>, "Loupe: 100 % under the pointer"],
  [<Kbd>G</Kbd>, "Review grid: every slide at once (G or Esc back)"],
  [<Kbd>P</Kbd>, "Capture: the tethered camera takes a picture into this tray (camera rig)"],
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd> <Kbd>↑</Kbd> <Kbd>↓</Kbd>
    </>,
    "In the grid: move the cursor (Space develops and steps on, X skips, R turns, Enter opens)",
  ],
  [<Kbd>C</Kbd>, "Copy colour from previous slide"],
  [<Kbd>0</Kbd>, "Reset all adjustments"],
  [<Kbd>W</Kbd>, "White balance: click a neutral spot on the photo"],
  [<Kbd>K</Kbd>, "Crop & straighten (Enter applies, Esc cancels)"],
  [
    <>
      <Kbd>←</Kbd> <Kbd>→</Kbd> <Kbd>↑</Kbd> <Kbd>↓</Kbd>
    </>,
    `While cropping: move the frame (${isMac ? "⌥" : "Alt"}: resize from the bottom-right, ⇧: bigger steps)`,
  ],
  [<Kbd>A</Kbd>, "Local adjustments on the photo: graduated, radial, brush (Esc closes)"],
  [
    <>
      <Kbd>O</Kbd> <Kbd>⌫</Kbd>
    </>,
    "In the Local tool: show the mask, delete the selected adjustment",
  ],
  [
    <>
      <Kbd>⌘ Z</Kbd> / <Kbd>⇧ ⌘ Z</Kbd>
    </>,
    "Undo / redo this slide's edits",
  ],
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

// ------------------------------------------------------------------ stats

/** Progress across every tray: slides per hour, trays left, when the target is reached. */
export function StatsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The target was changed (it lives in the config). */
  onSaved: () => void;
}) {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [target, setTarget] = React.useState("");
  const load = React.useCallback(async () => {
    try {
      const s = await api<Stats>("GET", "/api/stats");
      setStats(s);
      setTarget(String(s.target));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const saveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1 || n === stats?.target) return;
    try {
      await api("POST", "/api/config", { stats_target: n });
      onSaved();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const s = stats;
  const n = (x: number) => x.toLocaleString();
  const finish = s?.finish
    ? new Date(`${s.finish}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "long" })
    : null;
  const tiles: [string, string, string?][] = s
    ? [
        [
          "Slides per hour",
          s.per_hour ? String(s.per_hour) : "–",
          s.per_hour ? `over ${s.hours_worked} h of work` : "develop a few more",
        ],
        [
          "Done",
          `${n(s.slides.done)} of ${n(s.target)}`,
          `${Math.min(100, Math.round((s.slides.done / s.target) * 100))} %`,
        ],
        [
          "Projected finish",
          s.remaining === 0 ? "Done!" : (finish ?? "–"),
          s.remaining === 0
            ? ""
            : s.per_day
              ? `at ${s.per_day} slides a day (last 2 weeks)`
              : "no slides in the last 2 weeks",
        ],
        ["Work left", s.hours_left !== null ? `${s.hours_left} h` : "–", `${n(s.remaining)} slides`],
        ["Trays", `${s.trays.open} open`, `${s.trays.finished} of ${s.trays.total} in Immich`],
        [
          "Still to scan",
          s.trays_to_scan !== null ? plural(s.trays_to_scan, "tray") : "–",
          `${n(Math.max(0, s.target - s.slides.total))} slides not imported yet`,
        ],
        ["Today", String(s.today), `${s.last_7_days} in the last 7 days`],
        ["In the library", n(s.slides.total), `${n(s.slides.to_develop)} to develop · ${n(s.slides.skipped)} skipped`],
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Stats</DialogTitle>
          <DialogDescription>
            Across every tray in the library. Time between slides counts up to 10 minutes; longer is a break.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-2" aria-busy={!s}>
          {tiles.map(([label, value, note]) => (
            <div key={label} className="rounded-md border border-(--ss-line-soft) bg-(--ss-panel) px-3 py-2">
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="text-[18px] leading-6 font-semibold tabular-nums">{value}</dd>
              {note && <dd className="text-[11px] text-(--ss-dim)">{note}</dd>}
            </div>
          ))}
        </dl>
        <form onSubmit={saveTarget} className="flex items-end gap-1.5">
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor="stats-target">Target: slides to digitise in all</FieldLabel>
            <Input
              id="stats-target"
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Button type="submit" disabled={!s || !Number(target) || Number(target) === s.target}>
            Set
          </Button>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button className={primary}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto scrollbar-thin">
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
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button className={primary}>Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
