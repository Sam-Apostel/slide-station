// A hosted Slide Station (SLIDESTATION_AUTH=immich): sign in with an API key of the server's Immich;
// your Immich user is your account, with a library of its own (slidestation/accounts.py).
import * as React from "react";
import { Images, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, SIGNED_OUT, standalone, type AuthState } from "@/lib/api";

/** Renders the app once signed in (or when the server has no accounts), else the sign-in screen. */
export function AccountGate({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = React.useState<AuthState | null>(null);

  React.useEffect(() => {
    if (standalone) return;
    const load = () => api<AuthState>("GET", "/api/auth").then(setAuth, () => setAuth({ accounts: false, user: null }));
    load();
    window.addEventListener(SIGNED_OUT, load);
    return () => window.removeEventListener(SIGNED_OUT, load);
  }, []);

  if (standalone) return <>{children}</>;
  if (!auth) return null;
  if (auth.accounts && !auth.user) return <SignIn immichUrl={auth.immich_url ?? ""} onSignedIn={setAuth} />;
  // a new account starts the app from scratch: nothing of the last one's state may linger
  return <React.Fragment key={auth.user?.id ?? ""}>{children}</React.Fragment>;
}

function SignIn({ immichUrl, onSignedIn }: { immichUrl: string; onSignedIn: (a: AuthState) => void }) {
  const [key, setKey] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSignedIn(await api<AuthState>("POST", "/api/auth/login", { api_key: key.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const keys = immichUrl ? `${immichUrl.replace(/\/$/, "")}/user-settings?isOpen=api-keys` : "";
  return (
    <div className="grid h-dvh place-items-center bg-[var(--pro-canvas)] p-6 text-foreground">
      <Empty className="max-w-[440px] flex-none rounded-[12px] border border-solid border-border bg-(--ss-panel) px-8 py-8 shadow-[0_16px_60px_#0005]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Images />
          </EmptyMedia>
          <EmptyTitle className="text-[18px]">Sign in to Slide Station</EmptyTitle>
          <EmptyDescription>
            With an API key of your Immich{immichUrl ? ` (${immichUrl})` : ""}. Your slides stay in a library of your
            own on this server and go to your Immich.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <form onSubmit={submit} className="grid w-full gap-4 text-left">
            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="signin-key">Immich API key</FieldLabel>
                <Input
                  id="signin-key"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="paste your API key"
                />
                <FieldDescription>
                  Create one in Immich →{" "}
                  {keys ? (
                    <a href={keys} target="_blank" rel="noreferrer" className="underline">
                      Account settings → API keys
                    </a>
                  ) : (
                    "Account settings → API keys"
                  )}
                  , with asset.upload, asset.delete, album.read, album.create and albumAsset.create (Settings here lists
                  the rest for the round trip).
                </FieldDescription>
              </Field>
            </FieldGroup>
            {error && (
              <p role="alert" className="text-[12px] text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="bg-primary text-primary-foreground" disabled={busy || !key.trim()}>
              <LogIn /> Sign in
            </Button>
          </form>
        </EmptyContent>
      </Empty>
    </div>
  );
}
