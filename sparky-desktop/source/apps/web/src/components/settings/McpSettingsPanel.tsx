import { useState, type FormEvent } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { McpIcon } from "./McpIcon";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
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
  const [error, setError] = useState<string | null>(null);

  const save = (next: typeof connections) => updateSettings({ mcpServers: next });

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
          authorizationToken: authorizationToken.trim(),
          authorizationTokenRedacted: false,
          enabled: true,
        },
      ]);
      setName("");
      setEndpoint("");
      setAuthorizationToken("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid MCP endpoint.");
    }
  };

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">MCP</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Add streamable HTTP MCP servers here. Enabled servers are connected by Sparky's agent and their tools are available during a session.
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

      <SettingsSection title="Your MCP servers" icon={<McpIcon className="size-3.5" />}>
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
            <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
              Bearer token <span className="font-normal text-muted-foreground">(optional)</span>
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
