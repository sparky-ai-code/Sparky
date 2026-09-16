import { BrainIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Memory } from "@sparky/contracts";
import * as Cause from "effect/Cause";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand as useWebAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const EMPTY_INPUT = { title: "", content: "", category: "general", importance: 3 };

type Draft = typeof EMPTY_INPUT;

function formatScope(scope: Memory["scope"]): string {
  return scope === "global" ? "Global" : "Project";
}

function formatCommandFailure(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function MemorySettingsPanel() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Memory["scope"]>("global");
  const [isEditing, setIsEditing] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_INPUT);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const memoryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.memoryList({ environmentId, input: { query } }),
  );
  const addMemory = useWebAtomCommand(serverEnvironment.memoryAdd, { reportFailure: false });
  const updateMemory = useWebAtomCommand(serverEnvironment.memoryUpdate, { reportFailure: false });
  const deleteMemory = useWebAtomCommand(serverEnvironment.memoryDelete, { reportFailure: false });

  const memories = useMemo(() => memoryQuery.data?.memories ?? [], [memoryQuery.data]);

  const openNew = () => {
    setIsEditing(true);
    setEditing(null);
    setDraft({ ...EMPTY_INPUT });
    setScope("global");
    setFormError(null);
    setActionError(null);
  };

  const openEdit = (memory: Memory) => {
    setIsEditing(true);
    setEditing(memory);
    setScope(memory.scope);
    setDraft({
      title: memory.title,
      content: memory.content,
      category: memory.category,
      importance: memory.importance,
    });
    setFormError(null);
    setActionError(null);
  };

  const save = async () => {
    if (environmentId === null || !draft.title.trim() || !draft.content.trim()) {
      setFormError("Title and content are required.");
      return;
    }
    const result = editing
      ? await updateMemory({
          environmentId,
          input: { id: editing.id, ...draft, source: editing.source },
        })
      : await addMemory({
          environmentId,
          input: { scope, ...draft },
        });
    if (result._tag === "Failure") {
      setFormError(
        formatCommandFailure(
          result.cause,
          "Could not save this memory. Check the content and try again.",
        ),
      );
      return;
    }
    setEditing(null);
    setIsEditing(false);
    setDraft({ ...EMPTY_INPUT });
    setFormError(null);
    setActionError(null);
    memoryQuery.refresh();
  };

  const remove = async (memory: Memory) => {
    if (environmentId === null || !window.confirm(`Forget “${memory.title}”?`)) return;
    const result = await deleteMemory({ environmentId, input: { id: memory.id } });
    if (result._tag === "Success") {
      setActionError(null);
      memoryQuery.refresh();
      return;
    }
    setActionError(
      formatCommandFailure(result.cause, `Could not forget “${memory.title}”. Please try again.`),
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Memory"
        icon={<BrainIcon className="size-3.5" />}
        headerAction={
          <Button size="xs" onClick={openNew} disabled={environmentId === null}>
            <PlusIcon className="size-3.5" /> Add memory
          </Button>
        }
      >
        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-xs text-muted-foreground">
            Review and edit the user-approved facts, preferences, and conventions Sparky remembers.
            Global memories are available across projects; project memories stay with the current
            workspace.
          </p>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              type="search"
              placeholder="Search memories"
              aria-label="Search memories"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {memoryQuery.error ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
              <div>
                <p className="text-sm font-medium text-destructive">Could not load memories</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {memoryQuery.error}
                </p>
              </div>
              <Button size="xs" variant="outline" onClick={memoryQuery.refresh}>
                Retry
              </Button>
            </div>
          ) : null}
          {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
          {isEditing ? (
            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{editing ? "Edit memory" : "New memory"}</h3>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setIsEditing(false);
                    setEditing(null);
                    setDraft({ ...EMPTY_INPUT });
                    setFormError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
              <Input
                aria-label="Memory title"
                placeholder="Title"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
              <Textarea
                aria-label="Memory content"
                placeholder="What should Sparky remember?"
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                {!editing ? (
                  <Select
                    value={scope}
                    onValueChange={(value) => value && setScope(value as Memory["scope"])}
                  >
                    <SelectTrigger aria-label="Memory scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="global">Global memory</SelectItem>
                      <SelectItem value="project">Project memory</SelectItem>
                    </SelectPopup>
                  </Select>
                ) : (
                  <div className="flex items-center rounded-lg border px-3 text-xs text-muted-foreground">
                    {formatScope(scope)} memory
                  </div>
                )}
                <Input
                  aria-label="Memory category"
                  placeholder="Category"
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                />
                <Select
                  value={String(draft.importance)}
                  onValueChange={(value) =>
                    value && setDraft({ ...draft, importance: Number(value) })
                  }
                >
                  <SelectTrigger aria-label="Memory importance">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        Importance {value}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
              <Button size="sm" onClick={() => void save()}>
                {editing ? "Update memory" : "Save memory"}
              </Button>
            </div>
          ) : null}
          <div className="divide-y rounded-xl border border-border/70">
            {memoryQuery.isPending && !memoryQuery.error && memories.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Loading memories…</p>
            ) : null}
            {!memoryQuery.isPending && !memoryQuery.error && memories.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No memories found.</p>
            ) : null}
            {memories.map((memory) => (
              <article key={memory.id} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{memory.title}</h3>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                      <span className="rounded-full bg-muted px-2 py-0.5">
                        {formatScope(memory.scope)}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5">{memory.category}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5">
                        Importance {memory.importance}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${memory.title}`}
                      onClick={() => openEdit(memory)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Forget ${memory.title}`}
                      onClick={() => void remove(memory)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {memory.content}
                </p>
              </article>
            ))}
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
