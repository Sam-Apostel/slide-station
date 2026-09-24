import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  return (
    <Field>
      <FieldLabel htmlFor="watch-path">Watched folders</FieldLabel>
      <FieldDescription>
        Every folder put into a watched folder becomes a tray of its own, named after it (“1978-08 Lake Garda” is dated
        August 1978), once its scans have stopped changing for {Math.round(st.settle)} seconds. Nothing in it is ever
        changed or deleted; what was imported is remembered in the library.
        {st.root && ` On this server, only folders in ${st.root} can be watched.`}
      </FieldDescription>
      {st.folders.map((f) => (
        <div
          key={f.id}
          className="grid gap-1.5 rounded-md border border-border/60 p-2 text-[12px]"
          data-watched={f.path}
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium" title={f.path}>
              {f.path}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => remove(f)}>
              Stop watching
            </Button>
          </div>
          {f.error && <span className="text-destructive">{f.error}</span>}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`watch-done-${f.id}`}
                checked={f.require_done}
                onCheckedChange={(v) => change(f, { require_done: v === true })}
              />
              <Label htmlFor={`watch-done-${f.id}`} className="text-[12px] font-normal">
                Only once a .done file is in it
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`watch-upload-${f.id}`}
                checked={f.auto_upload}
                onCheckedChange={(v) => change(f, { auto_upload: v === true })}
              />
              <Label htmlFor={`watch-upload-${f.id}`} className="text-[12px] font-normal">
                Upload to Immich once imported
              </Label>
            </div>
          </div>
          {f.subfolders.length ? (
            <ul className="grid gap-0.5" aria-label={`Folders in ${f.path}`}>
              {f.subfolders.map((s) => (
                <li key={s.name} className="flex items-center gap-2" data-state={s.state}>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span
                    className={cn(
                      "shrink-0 truncate text-muted-foreground",
                      s.state === "error" && "text-destructive",
                      s.state === "imported" && !s.error && "text-[var(--pro-green)]",
                    )}
                  >
                    {subState(s)}
                  </span>
                  {s.state === "error" && (
                    <Button type="button" variant="outline" size="sm" onClick={() => retry(f, s)}>
                      Retry
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">No folders in it yet.</span>
          )}
        </div>
      ))}
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
            placeholder={st.root ? `a folder in ${st.root}` : "/path/to/the/share"}
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
    </Field>
  );
}
