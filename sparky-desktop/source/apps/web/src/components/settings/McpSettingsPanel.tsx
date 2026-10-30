import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FolderOpenIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type McpServerConnectionStatus } from "@sparky/contracts";

import { McpIcon } from "./McpIcon";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";

export function McpSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const connections = settings.mcpServers;
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authorizationToken, setAuthorizationToken] = useState("");
  const [authorizationHeaderName, setAuthorizationHeaderName] = useState("Authorization");
  const [blenderDirectoryPath, setBlenderDirectoryPath] = useState(
    settings.blenderMcp.directoryPath,
  );
  const [blenderSetupError, setBlenderSetupError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverStatuses, setServerStatuses] = useState<ReadonlyMap<string, McpServerConnectionStatus>>(
    () => new Map(),
  );
  const [checkingStatus, setCheckingStatus] = useState(false);
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const checkMcpServers = useAtomCommand(serverEnvironment.checkMcpServers, {
    reportFailure: false,
  });

  const save = (next: typeof connections) => updateSettings({ mcpServers: next });
  const blenderStatus = serverStatuses.get("blender-mcp");
  useEffect(() => {
    setBlenderDirectoryPath(settings.blenderMcp.directoryPath);
  }, [settings.blenderMcp.directoryPath]);

  const refreshServerStatuses = useCallback(async () => {
    if (!environmentId) return;
    setCheckingStatus(true);
    try {
      const result = await checkMcpServers({ environmentId, input: {} });
      if (result._tag === "Success") {
        setServerStatuses(new Map(result.value.map((status) => [status.id, status])));
      }
    } finally {
      setCheckingStatus(false);
    }
  }, [checkMcpServers, environmentId]);

  useEffect(() => {
    if (!environmentId || (connections.length === 0 && !settings.blenderMcp.enabled)) return;
    void refreshServerStatuses();
    const interval = setInterval(() => void refreshServerStatuses(), 60_000);
    return () => clearInterval(interval);
  }, [connections, environmentId, refreshServerStatuses, settings.blenderMcp.enabled]);

  const canBrowseBlenderFolder =
    typeof window !== "undefined" &&
    Boolean(window.nativeApi) &&
    (environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID || environmentId?.startsWith("wsl:") === true);
  const chooseBlenderFolder = async () => {
    try {
      const selectedPath = await readLocalApi()?.dialogs.pickFolder({
        initialPath: blenderDirectoryPath || undefined,
        ...(environmentId ? { targetEnvironmentId: environmentId } : {}),
      });
      if (selectedPath) {
        setBlenderDirectoryPath(selectedPath);
        setBlenderSetupError(null);
      }
    } catch (cause) {
      setBlenderSetupError(cause instanceof Error ? cause.message : "Could not open the folder picker.");
    }
  };
  const saveBlenderSetup = async () => {
    try {
      await updateSettings({
        blenderMcp: { enabled: true, directoryPath: blenderDirectoryPath.trim() },
      });
      setBlenderSetupError(null);
      await refreshServerStatuses();
    } catch (cause) {
      setBlenderSetupError(
        cause instanceof Error ? cause.message : "Could not save Blender MCP settings.",
      );
    }
  };

  const addConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedEndpoint = endpoint.trim();
    try {
      const parsedEndpoint = new URL(normalizedEndpoint);
      if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") {
        throw new Error("Use an HTTP or HTTPS endpoint.");
      }
      if (!normalizedName) throw new Error("Enter a name for this MCP server.");
      if (connections.some((server) => server.name.toLowerCase() === normalizedName.toLowerCase())) {
        throw new Error("Choose a unique server name.");
      }
      save([
        ...connections,
        {
          id: crypto.randomUUID(),
          name: normalizedName,
          url: parsedEndpoint.href,
          authorizationHeaderName: authorizationHeaderName.trim() || "Authorization",
          authorizationToken: authorizationToken.trim(),
          authorizationTokenRedacted: false,
          enabled: true,
        },
      ]);
      setName("");
      setEndpoint("");
      setAuthorizationToken("");
      setAuthorizationHeaderName("Authorization");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid MCP endpoint.");
    }
  };

  return (
    <SettingsPageContainer>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">MCP</h1>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Beta
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Add streamable HTTP MCP servers here. Blender MCP connects locally over stdio. Connections
          are saved in server settings and restored after restart; status is checked when configured
          and periodically.
        </p>
      </div>

      <SettingsSection title="Built-in MCPs" icon={<McpIcon className="size-3.5" />}>
        <SettingsRow
          title="Google Stitch"
          description="Generate UI designs with Google Stitch. Requires a Stitch API key."
          status="Streamable HTTP"
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setName("Google Stitch");
                setEndpoint("https://stitch.googleapis.com/mcp");
                setAuthorizationHeaderName("X-Goog-Api-Key");
                setAuthorizationToken("");
                setError(null);
              }}
            >
              Configure
            </Button>
          }
        />
        <SettingsRow
          title="Blender MCP"
          description="Use the official Blender MCP stdio server to control a running Blender session."
          status={
            !settings.blenderMcp.enabled
              ? "Disabled"
              : blenderStatus?.status === "online"
                ? `Online · ${blenderStatus.toolCount} tools`
                : blenderStatus?.status === "offline"
                  ? `Offline — ${blenderStatus.message ?? "check Blender MCP setup"}`
                  : "Checking…"
          }
          control={
            <Switch
              checked={settings.blenderMcp.enabled}
              onCheckedChange={(enabled) =>
                updateSettings({
                  blenderMcp: {
                    ...settings.blenderMcp,
                    enabled: Boolean(enabled),
                  },
                })
              }
              aria-label={`${settings.blenderMcp.enabled ? "Disable" : "Enable"} Blender MCP`}
            />
          }
        >
          <div className="space-y-3 pb-3.5">
            <div className="rounded-xl bg-muted/50 px-3.5 py-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Two things to set up</p>
              <ol className="mt-2 list-inside list-decimal space-y-1.5">
                <li>
                  Install the Blender add-on from the{" "}
                  <a
                    className="font-medium text-primary underline underline-offset-2"
                    href="https://www.blender.org/lab/mcp-server/"
                    rel="noreferrer"
                    target="_blank"
                  >
                    official Blender MCP page
                  </a>
                  , then enable it in Blender.
                </li>
                <li>
                  Install the MCP server and <code>uv</code> using the{" "}
                  <a
                    className="font-medium text-primary underline underline-offset-2"
                    href="https://projects.blender.org/lab/blender_mcp/wiki/Setup"
                    rel="noreferrer"
                    target="_blank"
                  >
                    official setup guide
                  </a>
                  . Keep Blender open when you use it.
                </li>
              </ol>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
                Blender MCP folder
                <Input
                  value={blenderDirectoryPath}
                  onChange={(event) => setBlenderDirectoryPath(event.currentTarget.value)}
                  placeholder={String.raw`C:\blender_mcp or C:\blender_mcp\mcp`}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canBrowseBlenderFolder}
                onClick={() => void chooseBlenderFolder()}
                title={
                  canBrowseBlenderFolder
                    ? "Choose the downloaded Blender MCP folder"
                    : "Folder picker is available in Sparky Desktop for local and WSL environments"
                }
              >
                <FolderOpenIcon className="size-3.5" />
                Browse
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!blenderDirectoryPath.trim() || checkingStatus}
                onClick={() => void saveBlenderSetup()}
              >
                Save & test connection
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose either the downloaded repository folder or its <code>mcp</code> subfolder. Sparky
              will find the server directory automatically. In the browser app, paste the full path.
            </p>
            {blenderSetupError ? (
              <p role="alert" className="text-xs text-destructive">
                {blenderSetupError}
              </p>
            ) : null}
            {!canBrowseBlenderFolder ? (
              <p className="text-xs text-muted-foreground">
                Folder browsing is available in Sparky Desktop for local and WSL environments.
              </p>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Browser"
          description="Use the shared browser to navigate, inspect pages, and interact with websites."
          status="Available in this session"
        />
        <SettingsRow
          title="Pull request review"
          description="Review a GitHub pull request and post actionable inline feedback."
          status="Available when GitHub is connected"
        />
      </SettingsSection>

      <SettingsSection
        title="Your MCP servers"
        icon={<McpIcon className="size-3.5" />}
        headerAction={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh MCP server statuses"
            onClick={() => void refreshServerStatuses()}
            disabled={checkingStatus || (connections.length === 0 && !settings.blenderMcp.enabled)}
          >
            <RefreshCwIcon className={checkingStatus ? "size-3 animate-spin" : "size-3"} />
          </Button>
        }
      >
        {connections.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground sm:px-5">
            No MCP servers added yet.
          </div>
        ) : (
          connections.map((connection) => (
            <div
              key={connection.id}
              className="flex min-w-0 items-center gap-3 border-t border-border/60 px-4 py-3.5 sm:px-5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-foreground">{connection.name}</p>
                <p className="truncate text-xs text-muted-foreground">{connection.url}</p>
              </div>
              <span
                role="status"
                className={
                  !connection.enabled
                    ? "inline-flex shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    : serverStatuses.get(connection.id)?.status === "online"
                      ? "inline-flex shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
                      : serverStatuses.get(connection.id)?.status === "offline"
                        ? "inline-flex shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                        : "inline-flex shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                }
              >
                {!connection.enabled
                  ? "Disabled"
                  : serverStatuses.get(connection.id)?.status === "online"
                    ? `Online · ${serverStatuses.get(connection.id)?.toolCount ?? 0} tools`
                    : serverStatuses.get(connection.id)?.status === "offline"
                      ? "Offline"
                      : "Checking…"}
              </span>
              <Switch
                checked={connection.enabled}
                onCheckedChange={(enabled) =>
                  save(connections.map((server) =>
                    server.id === connection.id ? { ...server, enabled: Boolean(enabled) } : server,
                  ))
                }
                aria-label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${connection.name}`}
                onClick={() => save(connections.filter((item) => item.id !== connection.id))}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          ))
        )}
        <form onSubmit={addConnection} className="grid gap-3 border-t border-border/60 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Server name
              <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="My MCP server" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Server URL
              <Input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.currentTarget.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Authentication header
              <Input
                value={authorizationHeaderName}
                onChange={(event) => setAuthorizationHeaderName(event.currentTarget.value)}
                placeholder="Authorization"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              {authorizationHeaderName.toLowerCase() === "authorization" ? "Bearer token" : "API key / header value"}{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
              <Input
                type="password"
                autoComplete="new-password"
                value={authorizationToken}
                onChange={(event) => setAuthorizationToken(event.currentTarget.value)}
                placeholder="Stored securely on the server"
              />
            </label>
          </div>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm"><PlusIcon className="size-4" /> Add server</Button>
          </div>
        </form>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
