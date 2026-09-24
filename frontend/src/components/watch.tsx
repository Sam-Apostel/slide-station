import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FolderOpen } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { desktop } from "@/lib/desktop";
import { api, plural, type WatchedFolder, type WatchedSub, type WatchState } from "@/lib/api";
import { cn } from "@/lib/utils";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What became of a sub-folder, in a few words. */
function subState(s: WatchedSub): string {
  if (s.state === "importing") return "importing…";
  if (s.state === "error") return `error: ${s.error}`;
  if (s.state === "imported")
    return s.note
      ? `imported (${s.note})`
      : `imported ${plural(s.slides ?? 0, "slide")}` + (s.error ? ` · upload failed: ${s.error}` : "");
  return s.note ? `waiting · ${s.note}` : "waiting to settle";
}

/**
 * Settings → Watched folders (watch.py): every sub-folder dropped into one becomes a tray once it
 * stops changing. The server app only (desktop, or a server under SLIDESTATION_WATCH_ROOT); the
 * browser version has its folder picker instead. Changes apply at once, not on Save.
 */
export function WatchedFolders() {
  const [st, setSt] = React.useState<WatchState | null>(null);
  const [path, setPath] = React.useState("");
  const load = React.useCallback(() => api<WatchState>("GET", "/api/watch").then(setSt, () => setSt(null)), []);

  React.useEffect(() => {
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!st?.available) return null;

  const add = async () => {
    try {
      await api("POST", "/api/watch", { path: path.trim() });
      setPath("");
      load();
    } catch (e) {
      toast.error(message(e));
    }
  };
  const change = async (f: WatchedFolder, body: Partial<WatchedFolder>) => {
    await api("PATCH", `/api/watch/${f.id}`, body).catch((e) => toast.error(message(e)));
    load();
  };
  const remove = async (f: WatchedFolder) => {
    await api("DELETE", `/api/watch/${f.id}`).catch((e) => toast.error(message(e)));
    load();
  };
  const retry = async (f: WatchedFolder, s: WatchedSub) => {
    await api("POST", `/api/watch/${f.id}/retry`, { name: s.name }).catch((e) => toast.error(message(e)));
    load();
  };
  const pick = async () => {
    const p = await desktop!.pickFolder({ title: "Folder to watch", defaultPath: path || undefined });
    if (p) setPath(p);
  };

  const toggle = (f: WatchedFolder, field: "require_done" | "auto_upload", label: string) => (
    <div className="flex items-center gap-2">
      <Switch
        id={`watch-${field}-${f.id}`}
        checked={f[field]}
        onCheckedChange={(v) => change(f, { [field]: v })}
        className="scale-90"
      />
      <Label htmlFor={`watch-${field}-${f.id}`} className="text-[11.5px] font-normal text-foreground/85">
        {label}
      </Label>
    </div>
  );

  return (
    <section className="grid grid-cols-1 gap-1.5">
      <h3 aria-hidden className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Watched folders
      </h3>
      <div className="divide-y divide-[var(--ss-line)] rounded-[8px] bg-[var(--ss-panel-2)] shadow-[inset_0_0_0_1px_var(--ss-line-soft)]">
        {st.folders.map((f) => (
          <div key={f.id} className="grid grid-cols-1 gap-2 px-3.5 py-3 text-[12px]" data-watched={f.path}>
            <div className="flex items-center gap-2">
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium" title={f.path}>
                {f.path}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => remove(f)}>
                Stop watching
              </Button>
            </div>
            {f.error && <span className="text-destructive">{f.error}</span>}
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {toggle(f, "require_done", "Only once a .done file is in it")}
              {toggle(f, "auto_upload", "Upload to Immich once imported")}
            </div>
            {f.subfolders.length ? (
              <ul
                className="grid grid-cols-1 gap-0.5 rounded-[6px] bg-[var(--ss-field)] px-2.5 py-1.5"
                aria-label={`Folders in ${f.path}`}
              >
                {f.subfolders.map((s) => (
                  <li key={s.name} className="flex min-h-[22px] items-center gap-2" data-state={s.state}>
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span
                      className={cn(
                        "shrink-0 truncate text-[11.5px] text-muted-foreground",
                        s.state === "error" && "text-destructive",
                        s.state === "imported" && !s.error && "text-[var(--pro-green)]",
                      )}
                    >
                      {subState(s)}
                    </span>
                    {s.state === "error" && (
                      <Button type="button" variant="outline" size="xs" onClick={() => retry(f, s)}>
                        Retry
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[11.5px] text-muted-foreground">No folders in it yet.</span>
            )}
          </div>
        ))}
        <div className="grid grid-cols-1 gap-1.5 px-3.5 py-3">
          <Label htmlFor="watch-path" className="sr-only">
            Watched folders
          </Label>
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <Input
                id="watch-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault(); // not the dialog's Save
                    if (path.trim()) add();
                  }
                }}
                placeholder={st.root ? `A folder in ${st.root}` : "/path/to/the/share"}
              />
            </div>
            {desktop && (
              <Button type="button" onClick={pick}>
                Choose…
              </Button>
            )}
            <Button type="button" onClick={add} disabled={!path.trim()}>
              Watch
            </Button>
          </div>
        </div>
      </div>
      <p className="px-1 text-[11.5px] leading-snug text-muted-foreground">
        Every folder put into one becomes a tray named after it (“1978-08 Lake Garda” is dated August 1978) once its
        scans have stopped changing for {Math.round(st.settle)} seconds. Nothing in it is changed or deleted. These
        apply at once, without Save.
        {st.root && ` On this server, only folders in ${st.root} can be watched.`}
      </p>
    </section>
  );
}
