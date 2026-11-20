import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRoundIcon, LockKeyholeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { SecretVaultEntry, SecretVaultWriteInput } from "@sparky/contracts";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";

const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.secrets;

export function PasskeysSettingsPanel() {
  const [items, setItems] = useState<readonly SecretVaultEntry[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [kind, setKind] = useState<"password" | "passkey">("password");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    try { setItems(await bridge.list()); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the secure vault."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const reset = () => {
    setEditingId(undefined); setKind("password"); setName(""); setOrigin("");
    setEmail(""); setDescription(""); setPassword("");
  };
  const edit = (entry: SecretVaultEntry) => {
    setEditingId(entry.id); setKind(entry.kind); setName(entry.name);
    setOrigin(entry.origin); setEmail(entry.email); setDescription(entry.description); setPassword("");
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bridge) return;
    setBusy(true); setError(null);
    try {
      const input: SecretVaultWriteInput = {
        ...(editingId ? { id: editingId } : {}),
        name, origin, email, description, kind,
        ...(kind === "password" && password ? { password } : {}),
      };
      await bridge.save(input);
      reset();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save credential.");
    } finally {
      setBusy(false);
      setPassword("");
    }
  };
  const remove = async (id: string) => {
    if (!bridge || !window.confirm("Remove this saved credential?")) return;
    setBusy(true);
    try { await bridge.remove(id); if (editingId === id) reset(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove credential."); }
    finally { setBusy(false); }
  };

  const inputStyle = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
  return (
    <SettingsPageContainer>
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight"><KeyRoundIcon className="size-5" />Password vault &amp; Passkeys</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Keep a reusable vault of named logins. Sparky can sign in to saved sites in its browser without receiving the underlying passwords.
        </p>
      </div>
      {!bridge ? (
        <SettingsSection title="Desktop required">
          <SettingsRow title="Secure vault unavailable" description="Passwords and device passkeys are managed in the Sparky desktop app, not a hosted or remote web session." />
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title="Your saved password vault" icon={<LockKeyholeIcon className="size-3.5" />}>
            {items.length === 0 ? (
              <SettingsRow title="No saved logins" description="Add a login below. Sparky will only use it on the exact site you specify." />
            ) : items.map((entry) => (
              <SettingsRow key={entry.id} title={<span className="flex items-center gap-2"><KeyRoundIcon className="size-4 text-muted-foreground" />{entry.name}</span>}
                description={<>{entry.origin} · {entry.kind === "passkey" ? "Device passkey" : entry.email || "Password"}{entry.description ? ` · ${entry.description}` : ""}</>}
                control={<><Button size="xs" variant="outline" onClick={() => edit(entry)}>Edit</Button><Button size="icon-xs" variant="ghost" aria-label={`Remove ${entry.name}`} disabled={busy} onClick={() => void remove(entry.id)}><Trash2Icon className="size-4" /></Button></>} />
            ))}
          </SettingsSection>
          <SettingsSection title={editingId ? "Edit login" : "Add login"} icon={<PlusIcon className="size-3.5" />}>
            <form onSubmit={(event) => void save(event)} className="space-y-3 p-4 sm:p-5">
              <label className="block space-y-1 text-xs font-medium">Credential type
                <select className={inputStyle} value={kind} onChange={(event) => { setKind(event.target.value as "password" | "passkey"); setPassword(""); }}>
                  <option value="password">Email and password</option>
                  <option value="passkey">Device passkey (WebAuthn)</option>
                </select>
              </label>
              <label className="block space-y-1 text-xs font-medium">Tool / login name
                <input className={inputStyle} required maxLength={128} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder="GitHub, Linear, Figma..." />
              </label>
              <label className="block space-y-1 text-xs font-medium">Site URL
                <input className={inputStyle} required type="url" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://example.com" />
              </label>
              <label className="block space-y-1 text-xs font-medium">Email / username
                <input className={inputStyle} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
              </label>
              {kind === "password" ? (
                <label className="block space-y-1 text-xs font-medium">Password
                  <input className={inputStyle} type="password" autoComplete="new-password" required={!editingId} value={password} onChange={(event) => setPassword(event.target.value)}
                    placeholder={editingId ? "Leave blank to keep existing password" : "Enter password"} />
                </label>
              ) : (
                <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  Device passkeys stay in your OS authenticator. Sparky saves only the site reference; sign-in requires the website's passkey button and your device's approval. Private keys cannot be imported or viewed by Sparky.
                </p>
              )}
              <label className="block space-y-1 text-xs font-medium">Description (optional)
                <textarea className={inputStyle} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Personal account" />
              </label>
              {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                {editingId && <Button type="button" variant="outline" onClick={reset}>Cancel</Button>}
                <Button type="submit" disabled={busy}>{busy ? "Saving…" : editingId ? "Save changes" : "Save login"}</Button>
              </div>
            </form>
          </SettingsSection>
          <p className="text-xs leading-5 text-muted-foreground">
            Passwords are encrypted using your operating system's credential protection. On systems without a secure keychain, Sparky refuses to store them instead of falling back to plain text. Credentials never sync to the server.
          </p>
        </>
      )}
    </SettingsPageContainer>
  );
}
