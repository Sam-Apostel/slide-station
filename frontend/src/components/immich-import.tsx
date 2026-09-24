import * as React from "react";
import { ArrowLeft, Check, Heart, Images } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, immichThumbUrl, plural, useImageSrc, type ImmichAlbum, type ImmichAsset } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Immich's thumbnail of a photo, or a quiet placeholder while it loads (or if it can't). */
function Thumb({ asset, className }: { asset: string | null; className?: string }) {
  const src = useImageSrc(asset ? immichThumbUrl(asset) : null);
  return src ? (
    <img src={src} alt="" loading="lazy" className={cn("object-cover", className)} />
  ) : (
    <span aria-hidden className={cn("block bg-(--ss-line-soft)", className)} />
  );
}

/**
 * Pull photos back in from Immich: pick an album, then its photos (all of them by default, except
 * ones a tray has already), and they become a new tray's scans to develop again. Each one's upload
 * replaces the photo in Immich: same albums, favourite kept, the old one to Immich's trash.
 */
export function ImmichImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (assets: string[], body: { name: string; album: string }) => Promise<boolean>;
}) {
  const [albums, setAlbums] = React.useState<ImmichAlbum[] | null>(null);
  const [album, setAlbum] = React.useState<ImmichAlbum | null>(null);
  const [assets, setAssets] = React.useState<ImmichAsset[] | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setAlbum(null);
    setAssets(null);
    setError("");
    setAlbums(null);
    api<ImmichAlbum[]>("GET", "/api/immich/albums").then(setAlbums, (e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [open]);

  const openAlbum = (a: ImmichAlbum) => {
    setAlbum(a);
    setAssets(null);
    setName(a.name);
    setError("");
    api<ImmichAsset[]>("GET", `/api/immich/albums/${a.id}/assets`).then(
      (list) => {
        setAssets(list);
        setPicked(new Set(list.filter((x) => !x.tray).map((x) => x.id)));
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!album || !assets || !picked.size) return;
    setBusy(true);
    // in album order, so the tray follows the album
    const ids = assets.filter((x) => picked.has(x.id)).map((x) => x.id);
    const n = name.trim() || album.name;
    // the tray's album is the Immich album itself: re-developed photos go back where they were
    const ok = await onImport(ids, { name: n, album: album.name });
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  const allPicked = !!assets?.length && picked.size === assets.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px]">
        <form onSubmit={submit} className="grid min-w-0 gap-[18px]">
          <DialogHeader>
            <DialogTitle>{album ? album.name : "Pull photos back in from Immich"}</DialogTitle>
            <DialogDescription>
              {album
                ? "Pick the photos to develop again. Uploading one replaces it in Immich: same albums, favourite kept, the old one goes to Immich's trash."
                : "Slides scanned years ago, with other tools, can be restored, cropped and re-dated like new scans."}
            </DialogDescription>
          </DialogHeader>

          {error ? (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          ) : !album ? (
            albums === null ? (
              <Spinner className="mx-auto my-6" />
            ) : !albums.length ? (
              <p className="text-[12px] text-muted-foreground">No albums in Immich.</p>
            ) : (
              <ul className="grid max-h-[50vh] gap-1 overflow-y-auto scrollbar-thin" aria-label="Immich albums">
                {albums.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-(--ss-line-soft) focus-visible:bg-(--ss-line-soft) focus-visible:outline-none"
                      onClick={() => openAlbum(a)}
                    >
                      <Thumb asset={a.thumb} className="size-10 shrink-0 rounded" />
                      <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                      <span className="text-[12px] text-muted-foreground">{plural(a.count, "item")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : assets === null ? (
            <Spinner className="mx-auto my-6" />
          ) : !assets.length ? (
            <p className="text-[12px] text-muted-foreground">No photos in this album.</p>
          ) : (
            <>
              <div
                role="group"
                aria-label="Photos"
                className="grid max-h-[46vh] grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5 overflow-y-auto scrollbar-thin"
              >
                {assets.map((a) => {
                  const on = picked.has(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${a.name}${a.date ? `, ${a.date}` : ""}${a.tray ? `, in tray “${a.tray}”` : ""}`}
                      onClick={() => toggle(a.id)}
                      className={cn(
                        "relative aspect-square overflow-hidden rounded-md border-2 border-transparent",
                        on && "border-primary",
                        !on && "opacity-60",
                      )}
                    >
                      <Thumb asset={a.id} className="size-full" />
                      {on && (
                        <Check className="absolute top-1 right-1 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" />
                      )}
                      {a.favorite && <Heart className="absolute top-1 left-1 size-3.5 fill-current text-white" />}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 text-[10px] text-white">
                        {a.tray ? `in ${a.tray}` : a.date || a.name}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Field>
                <FieldLabel htmlFor="ii-name">New tray</FieldLabel>
                <Input id="ii-name" value={name} onChange={(e) => setName(e.target.value)} />
                <FieldDescription>
                  Each photo becomes a slide with its date and description from Immich. They never came from a card,
                  so there's nothing to clean up afterwards.
                </FieldDescription>
              </Field>
            </>
          )}

          <DialogFooter className="items-center">
            {album && (
              <Button type="button" variant="ghost" className="mr-auto" onClick={() => setAlbum(null)}>
                <ArrowLeft /> Albums
              </Button>
            )}
            {!!assets?.length && album && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setPicked(new Set(allPicked ? [] : assets.map((x) => x.id)))}
              >
                {allPicked ? "Select none" : "Whole album"}
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            {album && (
              <Button
                type="submit"
                className="bg-primary text-primary-foreground"
                disabled={!picked.size || busy || !assets}
              >
                <Images /> Import {plural(picked.size, "photo")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
