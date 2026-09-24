import * as React from "react";
import { toast } from "sonner";
import { Check, ChevronRight, CloudUpload, HardDrive, LogOut, Sparkles } from "lucide-react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { WatchedFolders } from "@/components/watch";
import { desktop } from "@/lib/desktop";
import {
  api,
  plural,
  SIGNED_OUT,
  standalone,
  type AppState,
  type AuthState,
  type Config,
  type ImmichAlbum,
  type InsightsState,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export type SettingsPane = "immich" | "library" | "smart";

const PANES: { id: SettingsPane; label: string; icon: React.ReactNode }[] = [
  { id: "immich", label: "Immich", icon: <CloudUpload /> },
  { id: "library", label: "Library", icon: <HardDrive /> },
  { id: "smart", label: "Smart features", icon: <Sparkles /> },
];

/** The pane the dialog was last left on: it opens there again unless asked for another. */
let lastPane: SettingsPane = "immich";

const gb = (n: number) =>
  n >= 1e8 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where the models run, for the Smart features pane. */
const here = standalone ? "in this browser" : "on this computer";

/** What the Immich API key has to allow, by what it is for. */
const PERMISSIONS: { what: string; scopes: string[] }[] = [
  { what: "Uploading", scopes: ["asset.upload", "asset.delete", "album.read", "album.create", "albumAsset.create"] },
  {
    what: "The round trip: dates and captions in place, pulling photos back in",
    scopes: ["asset.read", "asset.update", "asset.view", "asset.download", "albumAsset.delete"],
  },
  { what: "Scans stacked under each slide", scopes: ["stack.read", "stack.create", "stack.delete"] },
  { what: "Tags and the names of the people on the slides", scopes: ["tag.create", "tag.asset"] },
];

export function SettingsDialog({
  open,
  onOpenChange,
  pane: requested,
  config,
  quota,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on this pane (e.g. Immich when an upload needs it); else where it was left. */
  pane?: SettingsPane;
  config: Config | undefined;
  /** Room used and allowed, when the server sets quotas. */
  quota?: AppState["quota"];
  onSaved: () => void;
}) {
  const [pane, setPane] = React.useState<SettingsPane>(lastPane);
  const [url, setUrl] = React.useState("");
  const [key, setKey] = React.useState("");
  const [library, setLibrary] = React.useState("");
  const [keepOriginals, setKeepOriginals] = React.useState(true);
  const [keepExports, setKeepExports] = React.useState(false);
  const [stackOriginals, setStackOriginals] = React.useState(false);
  // one album for every tray ("" = an album per tray, named after it) and the tray tag
  const [album, setAlbum] = React.useState("");
  const [albums, setAlbums] = React.useState<ImmichAlbum[] | null>(null);
  const [tagTrays, setTagTrays] = React.useState(true);
  const [learning, setLearning] = React.useState(true);
  const [people, setPeople] = React.useState(false);
  const [learned, setLearned] = React.useState<{ examples: number; min_examples: number } | null>(null);
  const [suggestTags, setSuggestTags] = React.useState(false);
  const [lookalikes, setLookalikes] = React.useState(false);
  const [openEyes, setOpenEyes] = React.useState(false);
  const [suggestCaptions, setSuggestCaptions] = React.useState(false);
  const [insights, setInsights] = React.useState<InsightsState | null>(null);
  const [test, setTest] = React.useState<{ ok?: boolean; message: string } | null>(null);
  const [saving, setSaving] = React.useState(false);
  // a hosted server: signed in with an Immich API key, the library and Immich are the server's
  const [auth, setAuth] = React.useState<AuthState | null>(null);
  const hosted = !!auth?.accounts;
  const scroller = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open || !config) return;
    setPane(requested ?? lastPane);
    if (!standalone) api<AuthState>("GET", "/api/auth").then(setAuth, () => setAuth(null));
    setUrl(config.immich_url || "");
    setKey("");
    setLibrary(config.library);
    setKeepOriginals(config.keep_originals);
    setKeepExports(config.keep_exports);
    setStackOriginals(!!config.upload_originals_stacked);
    setAlbum(config.immich_album || "");
    setTagTrays(config.tag_trays ?? true);
    setAlbums(null);
    if (config.has_key) api<ImmichAlbum[]>("GET", "/api/immich/albums").then(setAlbums, () => setAlbums(null));
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

  React.useEffect(() => {
    lastPane = pane;
    scroller.current?.scrollTo({ top: 0 });
  }, [pane]);

  const values = {
    immich_url: url.trim(),
    library: library.trim(),
    keep_originals: keepOriginals,
    keep_exports: keepExports,
    upload_originals_stacked: stackOriginals,
    immich_album: album,
    tag_trays: tagTrays,
    learning_enabled: learning,
    insights_enabled: suggestTags,
    lookalike_enabled: lookalikes,
    eyes_enabled: openEyes,
    ...(standalone ? {} : { captions_enabled: suggestCaptions }), // captions: the desktop app only
    people_enabled: people,
  };
  const saved = config && {
    immich_url: config.immich_url || "",
    library: config.library,
    keep_originals: config.keep_originals,
    keep_exports: config.keep_exports,
    upload_originals_stacked: !!config.upload_originals_stacked,
    immich_album: config.immich_album || "",
    tag_trays: config.tag_trays ?? true,
    learning_enabled: config.learning_enabled ?? true,
    insights_enabled: config.insights_enabled ?? false,
    lookalike_enabled: !!config.lookalike_enabled,
    eyes_enabled: !!config.eyes_enabled,
    ...(standalone ? {} : { captions_enabled: config.captions_enabled ?? false }),
    people_enabled: !!config.people_enabled,
  };
  const dirty = !!key.trim() || JSON.stringify(values) !== JSON.stringify(saved);
  const connected = !!config?.has_key && !!config.immich_url;

  const runTest = async () => {
    setTest({ message: "Testing…" });
    try {
      setTest(await api("POST", "/api/immich/test", { immich_url: url, immich_key: key }));
    } catch (e) {
      setTest({ ok: false, message: message(e) });
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("POST", "/api/config", {
        ...values,
        immich_key: key.trim(),
        immich_album_name: album
          ? (albums?.find((a) => a.id === album)?.name ?? config?.immich_album_name ?? "")
          : "",
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
          (err) => toast.error(message(err)),
        );
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    await api("POST", "/api/auth/logout").catch(() => {});
    onOpenChange(false);
    window.dispatchEvent(new Event(SIGNED_OUT));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(620px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
          <TabsPrimitive.Root
            value={pane}
            onValueChange={(v) => setPane(v as SettingsPane)}
            orientation="vertical"
            className="flex min-h-0 flex-1 flex-col sm:flex-row"
          >
            {/* sidebar: the panes, and who is signed in */}
            <aside className="flex shrink-0 flex-col gap-3 border-b border-[var(--ss-line-soft)] bg-[var(--ss-rail)] p-3 sm:w-[190px] sm:border-r sm:border-b-0">
              <DialogTitle className="px-2 pt-1.5 text-[13px]">Settings</DialogTitle>
              <DialogDescription className="sr-only">
                Immich, where the library lives, and the features that run {here}.
              </DialogDescription>
              <TabsPrimitive.List aria-label="Settings" className="flex gap-0.5 overflow-x-auto sm:flex-col">
                {PANES.map((p) => (
                  <TabsPrimitive.Trigger
                    key={p.id}
                    value={p.id}
                    className="flex h-[28px] shrink-0 cursor-default items-center gap-2 rounded-[6px] px-2 text-[12px] text-[var(--ss-muted)] outline-none hover:bg-white/[0.04] hover:text-foreground focus-visible:bg-white/[0.06] data-[state=active]:bg-[var(--pro-selection)] data-[state=active]:text-foreground data-[state=active]:[&_svg]:text-[var(--ss-accent)] [&_svg]:size-[14px] [&_svg]:shrink-0"
                  >
                    {p.icon}
                    <span className="flex-1 text-left">{p.label}</span>
                    {p.id === "immich" && (
                      <span
                        aria-hidden
                        title={connected ? "Connected" : "Not connected"}
                        className={cn(
                          "size-[6px] rounded-full",
                          connected ? "bg-[var(--pro-green)]" : "bg-white/20",
                        )}
                      />
                    )}
                  </TabsPrimitive.Trigger>
                ))}
              </TabsPrimitive.List>
              {auth?.user && (
                <div className="flex items-center gap-2 rounded-[8px] bg-[var(--ss-panel-2)] p-2 sm:mt-auto">
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--ss-accent)] text-[12px] font-semibold text-[var(--ss-ink)]"
                  >
                    {(auth.user.name || auth.user.email || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-[11px] text-muted-foreground">Signed in as</div>
                    <div className="truncate text-[12px] font-medium" title={auth.user.email}>
                      {auth.user.name || auth.user.email}
                    </div>
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={signOut} aria-label="Sign out" title="Sign out">
                    <LogOut className="size-[14px]" />
                  </Button>
                </div>
              )}
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6">
                <Pane value="immich" title="Immich" lede="Where finished slides go, and where the round trip reads from.">
                  <Group title="Connection">
                    <FieldRow id="cfg-url" label="Immich server URL">
                      <Input
                        id="cfg-url"
                        value={url}
                        readOnly={hosted}
                        className={cn(hosted && "text-muted-foreground")}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="http://your-server:2283"
                      />
                      {hosted && <Hint>Set by this Slide Station server: your account is on it.</Hint>}
                    </FieldRow>
                    <FieldRow id="cfg-key" label="Immich API key">
                      <Input
                        id="cfg-key"
                        type="password"
                        autoComplete="off"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder={config?.has_key ? "Saved — leave empty to keep it" : "Paste your API key"}
                      />
                      <Hint>
                        Create one in Immich under Account settings → API keys.
                        {standalone && " It is kept in this browser only."}
                      </Hint>
                    </FieldRow>
                    <div className="flex min-h-[44px] items-center gap-3 px-3.5 py-2.5">
                      <Button type="button" onClick={runTest} disabled={!url.trim()}>
                        Test connection
                      </Button>
                      <span
                        role="status"
                        className={cn(
                          "flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground",
                          test?.ok === true && "text-[var(--pro-green)]",
                          test?.ok === false && "text-destructive",
                        )}
                      >
                        {test ? (
                          <>
                            {test.ok === undefined && <Spinner className="size-3" />}
                            {test.ok && <Check className="size-3.5 shrink-0" />}
                            <span className="min-w-0 break-words">{test.message}</span>
                          </>
                        ) : connected ? (
                          "A key is saved for this server."
                        ) : (
                          "Not connected yet."
                        )}
                      </span>
                    </div>
                  </Group>
                  <Permissions />
                  {standalone && (
                    <Note>
                      Immich has to accept requests from this page: serve Slide Station from Immich's own address, or
                      let its reverse proxy allow <code className="text-foreground/80">{location.origin}</code> (CORS).
                    </Note>
                  )}

                  <Group title="Uploads">
                    <FieldRow id="cfg-album" label="Immich album">
                      <NativeSelect
                        id="cfg-album"
                        value={album}
                        onChange={(e) => setAlbum(e.target.value)}
                        disabled={!config?.has_key && !album}
                        wrapperClassName="w-full"
                      >
                        <NativeSelectOption value="">An album per tray, named after it</NativeSelectOption>
                        {album && !albums?.some((a) => a.id === album) && (
                          <NativeSelectOption value={album}>{config?.immich_album_name || album}</NativeSelectOption>
                        )}
                        {(albums ?? []).map((a) => (
                          <NativeSelectOption key={a.id} value={a.id}>
                            {a.name} ({plural(a.count, "photo")})
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Hint>
                        {album
                          ? "Every tray goes into this album. Trays already in Immich move in on their next upload."
                          : config?.has_key
                            ? "Or pick one album for every tray, shared albums included."
                            : "Save an API key to pick one album for every tray."}
                      </Hint>
                    </FieldRow>
                    <ToggleRow
                      id="cfg-tag-trays"
                      checked={tagTrays}
                      onChange={setTagTrays}
                      title="Tag each photo with its tray"
                      description={
                        <>
                          As <code className="text-foreground/80">Trays/&lt;tray name&gt;</code>.
                        </>
                      }
                    />
                    <ToggleRow
                      id="cfg-stack"
                      checked={stackOriginals}
                      onChange={setStackOriginals}
                      title="Upload the untouched scans too, stacked under each slide"
                      description="Immich shows the developed photo, its scans sit in the stack behind it (~5 MB a scan). Needs Immich with stacks."
                    />
                  </Group>
                </Pane>

                <Pane value="library" title="Library" lede="Originals, previews and finished JPEGs, about 6 MB a slide.">
                  <Group title="Location">
                    {standalone ? (
                      <BrowserLibrary config={config} />
                    ) : hosted ? (
                      <HostedLibrary quota={quota} />
                    ) : (
                      <FieldRow id="cfg-lib" label="Library folder">
                        <FolderInput id="cfg-lib" value={library} onChange={setLibrary} pickerTitle="Library folder" />
                        <Hint>60 GB for 10,000 slides with the defaults, so an external drive is a good home.</Hint>
                      </FieldRow>
                    )}
                  </Group>
                  <Group title="After upload">
                    <ToggleRow
                      id="cfg-keep"
                      checked={keepOriginals}
                      onChange={setKeepOriginals}
                      title="Keep the original scans"
                      description="The safest choice, about 5 MB a slide."
                    />
                    <ToggleRow
                      id="cfg-keep-exp"
                      checked={keepExports}
                      onChange={setKeepExports}
                      title="Also keep the finished JPEGs"
                      description="About 6 MB a slide; Immich has them already."
                    />
                  </Group>
                  {/* the browser version reads a folder itself (its picker); a server watches paths */}
                  {!standalone && <WatchedFolders />}
                </Pane>

                <Pane value="smart" title="Smart features" lede={`They run ${here}, in the background. Nothing changes on a slide until you accept a suggestion.`}>
                  <Group title="Developing">
                    <ToggleRow
                      id="cfg-learn"
                      checked={learning}
                      onChange={setLearning}
                      title="Learn from my edits"
                      description={
                        !learned
                          ? "Suggests settings for new slides; every developed slide becomes an example."
                          : learned.examples < learned.min_examples
                            ? `Suggests settings for new slides once ${learned.min_examples} are developed (${learned.examples} so far).`
                            : `Suggests settings for new slides, learned from ${plural(learned.examples, "developed slide")}.`
                      }
                      aside={
                        !!learned?.examples && (
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
                        )
                      }
                    />
                  </Group>

                  <Group title="Tags and look-alikes">
                    <ToggleRow
                      id="cfg-insights"
                      checked={suggestTags}
                      onChange={setSuggestTags}
                      title="Suggest tags"
                      badge={<ModelBadge ready={insights?.ready} downloading={insights?.downloading} mb={insights?.model_mb ?? 155} />}
                      description="Recognises scenes (beach, snow, wedding, dog…) and points out slides that look like the same shot, brackets that may be two slides, and the scenes of a tray. Accepted tags go to Immich as tags."
                    />
                    <ToggleRow
                      id="cfg-lookalike"
                      nested
                      disabled={!suggestTags}
                      checked={lookalikes}
                      onChange={setLookalikes}
                      title="After uploading, look for photos in Immich that look alike"
                      description="Finds a slide you scanned before (say with another tool, years ago) and offers to replace it."
                    />
                    <ToggleRow
                      id="cfg-eyes"
                      nested
                      disabled={!suggestTags}
                      checked={openEyes}
                      onChange={setOpenEyes}
                      title="Prefer the shot with open eyes"
                      badge={<ModelBadge ready={insights?.eyes?.ready} mb={insights?.eyes?.model_mb ?? 5} />}
                      description="Of slides that look like the same shot, keep the sharpest where nobody blinked."
                    />
                  </Group>

                  <Group title="Captions and people">
                    {!standalone && (
                      <ToggleRow
                        id="cfg-captions"
                        checked={suggestCaptions}
                        onChange={setSuggestCaptions}
                        title="Suggest captions"
                        badge={
                          <ModelBadge
                            ready={insights?.captions.ready}
                            downloading={insights?.downloading}
                            mb={insights?.captions.model_mb ?? 276}
                          />
                        }
                        description="A short description of each slide (“A red car parked in front of a house.”), a few seconds a slide. Accepted, it's what Immich shows as the description. Never replaces a caption you typed."
                      />
                    )}
                    <ToggleRow
                      id="cfg-people"
                      checked={people}
                      onChange={setPeople}
                      title="Recognise people across my slides"
                      badge={!config?.people_enabled && <ModelBadge mb={39} />}
                      description="Groups faces by person so you name each person once; Immich gets the names as tags."
                    />
                  </Group>
                  {standalone && (
                    <Note>The models are kept in the library, so a library folder on disk shares them with the desktop app.</Note>
                  )}
                </Pane>
              </div>

              <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--ss-line-soft)] bg-[var(--ss-panel)] px-6 py-3">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" aria-live="polite">
                  {dirty ? "Unsaved changes" : ""}
                </span>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={saving} className="min-w-[72px] bg-primary text-primary-foreground">
                  {saving ? <Spinner className="size-3" /> : "Save"}
                </Button>
              </footer>
            </div>
          </TabsPrimitive.Root>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ building blocks

function Pane({
  value,
  title,
  lede,
  children,
}: {
  value: SettingsPane;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <TabsPrimitive.Content value={value} className="grid grid-cols-1 gap-5 outline-none">
      <header className="grid gap-1">
        <h2 className="text-[15px] leading-tight font-semibold">{title}</h2>
        <p className="text-[12px] text-muted-foreground">{lede}</p>
      </header>
      {children}
    </TabsPrimitive.Content>
  );
}

/** A titled inset group of rows, like the system's own settings. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="grid grid-cols-1 gap-1.5">
      <h3 id={id} className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="divide-y divide-[var(--ss-line)] rounded-[8px] bg-[var(--ss-panel-2)] shadow-[inset_0_0_0_1px_var(--ss-line-soft)]">
        {children}
      </div>
    </section>
  );
}

function FieldRow({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 px-3.5 py-3">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/** A setting that is on or off: what it does on the left, the switch on the right. */
function ToggleRow({
  id,
  title,
  description,
  badge,
  aside,
  checked,
  onChange,
  disabled,
  nested,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  /** Next to the title, e.g. what the model it needs weighs. */
  badge?: React.ReactNode;
  /** Before the switch, e.g. a button acting on the setting. */
  aside?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Depends on the row above: indented, and off limits while that is off. */
  nested?: boolean;
}) {
  return (
    <div
      data-disabled={disabled || undefined}
      className={cn("flex items-center gap-4 px-3.5 py-3", nested && "pl-8", disabled && "opacity-50")}
    >
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Label htmlFor={id} className="text-[12px] leading-snug font-medium">
            {title}
          </Label>
          {badge}
        </div>
        {description && (
          <p id={`${id}-desc`} className="text-[11.5px] leading-snug text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {aside}
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={description ? `${id}-desc` : undefined}
      />
    </div>
  );
}

/** Whether a model is on this computer yet, or what it will weigh. */
function ModelBadge({ ready, downloading, mb }: { ready?: boolean; downloading?: boolean; mb: number }) {
  const base = "inline-flex h-[17px] items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium";
  if (ready)
    return (
      <span className={cn(base, "bg-[color-mix(in_srgb,var(--pro-green)_16%,transparent)] text-[var(--pro-green)]")}>
        <Check className="size-2.5" strokeWidth={3} />
        Downloaded
      </span>
    );
  if (downloading)
    return (
      <span className={cn(base, "bg-white/[0.07] text-muted-foreground")}>
        <Spinner className="size-2.5" />
        Downloading…
      </span>
    );
  return <span className={cn(base, "bg-white/[0.07] text-muted-foreground")}>{mb} MB download</span>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11.5px] leading-snug text-muted-foreground">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="-mt-2 px-1 text-[11.5px] leading-snug text-muted-foreground">{children}</p>;
}

/** The API key's permissions, folded away until wanted. */
function Permissions() {
  return (
    <details className="group -mt-2 px-1 text-[11.5px] text-muted-foreground">
      <summary className="flex w-fit cursor-default list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        Which permissions does the key need?
      </summary>
      <dl className="mt-2 grid gap-2.5 rounded-[8px] bg-[var(--ss-field)] p-3">
        {PERMISSIONS.map((p, i) => (
          <div key={p.what} className="grid gap-1">
            <dt className="text-foreground/85">
              {p.what}
              {i === 0 && <span className="text-muted-foreground"> (required)</span>}
            </dt>
            <dd className="flex flex-wrap gap-1">
              {p.scopes.map((s) => (
                <code key={s} className="rounded-[4px] bg-[var(--ss-panel-2)] px-1.5 py-px font-mono text-[10.5px] text-foreground/85">
                  {s}
                </code>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** A path field; in the desktop app it gets a native “Choose…” folder picker next to it. */
export function FolderInput({
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

/** A hosted server: the library is the server's; how much room it takes, when there are quotas. */
function HostedLibrary({ quota }: { quota?: AppState["quota"] }) {
  const meters = [
    quota?.library && { label: "Library", ...quota.library },
    quota?.uploads && { label: "Folders waiting to be imported", ...quota.uploads },
  ].filter((m): m is { label: string; used: number; limit: number } => !!m);
  return (
    <div className="grid gap-3 px-3.5 py-3">
      <p className="text-[12px] leading-snug">
        Your trays live on this server, in a library of your own that nobody else signed in here can see.
      </p>
      {meters.map((m) => {
        const share = Math.min(1, m.used / m.limit);
        return (
          <div key={m.label} className="grid gap-1">
            <div className="flex justify-between text-[11.5px] text-muted-foreground">
              <span>{m.label}</span>
              <span>
                {gb(m.used)} of {gb(m.limit)}
              </span>
            </div>
            <div className="h-[5px] overflow-hidden rounded-full bg-[var(--ss-field)]">
              <div
                className={cn("h-full rounded-full", share > 0.9 ? "bg-destructive" : "bg-[var(--pro-accent)]")}
                style={{ width: `${share * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
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
    <div className="grid gap-2 px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-[12px] leading-snug">{where}</span>
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
      <Hint>
        {canPick
          ? "A folder on disk has the same layout as the desktop app's library, so either app can open it."
          : "To keep the library in a folder on disk, use Chrome or Edge (or the desktop app)."}{" "}
        Trays already in one place stay there when you switch.
      </Hint>
    </div>
  );
}
