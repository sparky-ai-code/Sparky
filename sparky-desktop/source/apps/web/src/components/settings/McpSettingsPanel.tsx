import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import type { McpServerConnectionStatus } from "@sparky/contracts";

import { McpIcon } from "./McpIcon";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
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
  const [transport, setTransport] = useState<"streamable-http" | "stdio">("streamable-http");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [authorizationToken, setAuthorizationToken] = useState("");
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
    if (!environmentId || connections.length === 0) return;
    void refreshServerStatuses();
    const interval = setInterval(() => void refreshServerStatuses(), 60_000);
    return () => clearInterval(interval);
  }, [connections, environmentId, refreshServerStatuses]);

  const addConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedEndpoint = endpoint.trim();
    try {
      if (!normalizedName) throw new Error("Enter a name for this MCP server.");
      if (connections.some((server) => server.name.toLowerCase() === normalizedName.toLowerCase())) {
        throw new Error("Choose a unique server name.");
      }
      let url = "";
      let normalizedCommand = "";
      let parsedEnv: Record<string, string> = {};
      if (transport === "stdio") {
        normalizedCommand = command.trim();
        if (!normalizedCommand) throw new Error("Enter the executable for the local MCP server.");
        if (env.trim()) {
          const value: unknown = JSON.parse(env);
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              Object.values(value).some((item) => typeof item !== "string")) {
            throw new Error("Environment variables must be a JSON object with string values.");
          }
          parsedEnv = value as Record<string, string>;
        }
      } else {
        const parsedEndpoint = new URL(normalizedEndpoint);
        if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.protocol !== "http:") {
          throw new Error("Use an HTTP or HTTPS endpoint.");
        }
        url = parsedEndpoint.href;
      }
      save([
        ...connections,
        {
          id: crypto.randomUUID(),
          name: normalizedName,
          transport,
          url,
          command: normalizedCommand,
          args: args.split(/\r?\n/u).map((arg) => arg.trim()).filter(Boolean),
          env: parsedEnv,
          authorizationToken: authorizationToken.trim(),
          authorizationTokenRedacted: false,
          enabled: true,
        },
      ]);
      setName("");
      setEndpoint("");
      setCommand("");
      setArgs("");
      setEnv("");
      setAuthorizationToken("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid MCP configuration.");
    }
  };

  return (
    <SettingsPageContainer>
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Plugins</h1>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Beta
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Add MCP servers, app integrations, and local tools here. Connections are saved in server
          settings and restored after restart. Local command-based plugins execute on this machine.
        </p>
      </div>

      <SettingsSection title="Built-in MCPs" icon={<McpIcon className="size-3.5" />}>
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
        title="Configured plugins"
        icon={<McpIcon className="size-3.5" />}
        headerAction={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh MCP server statuses"
            onClick={() => void refreshServerStatuses()}
            disabled={checkingStatus || connections.length === 0}
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
                <p className="truncate text-xs text-muted-foreground">
                  {connection.transport === "stdio"
                    ? `${connection.command} ${(connection.args ?? []).join(" ")}`
                    : connection.url}
                </p>
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
              Plugin name
              <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="My MCP server" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Connection type
              <select
                value={transport}
                onChange={(event) => setTransport(event.currentTarget.value as typeof transport)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="streamable-http">Streamable HTTP</option>
                <option value="stdio">Local command (stdio)</option>
              </select>
            </label>
            {transport === "streamable-http" ? (
              <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
                Server URL
                <Input type="url" value={endpoint} onChange={(event) => setEndpoint(event.currentTarget.value)} placeholder="https://example.com/mcp" />
              </label>
            ) : (
              <>
                <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
                  Executable
                  <Input value={command} onChange={(event) => setCommand(event.currentTarget.value)} placeholder="npx" />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
                  Arguments <span className="font-normal text-muted-foreground">(one per line)</span>
                  <textarea value={args} onChange={(event) => setArgs(event.currentTarget.value)} rows={3} className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder="--yes&#10;@example/mcp-server" />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
                  Environment variables <span className="font-normal text-muted-foreground">(JSON object, optional)</span>
                  <textarea value={env} onChange={(event) => setEnv(event.currentTarget.value)} rows={3} className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder={'{"API_KEY":"…"}'} />
                </label>
              </>
            )}
            {transport === "streamable-http" ? (
              <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
                Bearer token <span className="font-normal text-muted-foreground">(optional)</span>
                <Input type="password" autoComplete="new-password" value={authorizationToken} onChange={(event) => setAuthorizationToken(event.currentTarget.value)} placeholder="Stored securely on the server" />
              </label>
            ) : null}
          </div>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm"><PlusIcon className="size-4" /> Add plugin</Button>
          </div>
        </form>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
