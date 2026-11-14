import { FileTextIcon, Trash2Icon, UploadCloudIcon } from "lucide-react";
import { useCallback, useState } from "react";
import * as Cause from "effect/Cause";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand as useWebAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function messageFromCause(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : "The skill could not be saved.";
}

function skillMetadata(fileName: string, content: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const metadata = frontmatter?.[1] ?? "";
  const rawName = metadata.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const name = (rawName || fileName.replace(/\.md$/i, ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  const rawDescription = metadata.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const description = (rawDescription || body.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))?.trim() || "").slice(0, 200);
  return { name, description, body };
}

export function SkillsSettingsPanel() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const skillsQuery = useEnvironmentQuery(environmentId === null ? null : serverEnvironment.skillList({ environmentId, input: {} }));
  const saveSkill = useWebAtomCommand(serverEnvironment.skillSave, { reportFailure: false });
  const deleteSkill = useWebAtomCommand(serverEnvironment.skillDelete, { reportFailure: false });
  const refreshProviders = useWebAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });

  const addFiles = useCallback(async (files: FileList | File[]) => {
    if (environmentId === null) return;
    setError(null);
    let savedAny = false;
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".md")) {
        setError("Only Markdown (.md) files can be added as skills.");
        continue;
      }
      const content = await file.text();
      const { name, description, body } = skillMetadata(file.name, content);
      if (!name) {
        setError(`Could not make a valid skill name from ${file.name}.`);
        continue;
      }
      const result = await saveSkill({ environmentId, input: { name, description, content: body } });
      if (result._tag === "Failure") setError(messageFromCause(result.cause));
      else savedAny = true;
    }
    if (savedAny) {
      skillsQuery.refresh();
      const refreshed = await refreshProviders({ environmentId, input: {} });
      if (refreshed._tag === "Failure") setError("Skill saved, but provider skill discovery could not be refreshed.");
    }
  }, [environmentId, refreshProviders, saveSkill, skillsQuery]);

  const remove = async (name: string) => {
    if (environmentId === null || !window.confirm(`Remove the “${name}” skill?`)) return;
    const result = await deleteSkill({ environmentId, input: { name } });
    if (result._tag === "Failure") setError(messageFromCause(result.cause));
    else {
      setError(null);
      skillsQuery.refresh();
      const refreshed = await refreshProviders({ environmentId, input: {} });
      if (refreshed._tag === "Failure") setError("Skill removed, but provider skill discovery could not be refreshed.");
    }
  };

  const skills = skillsQuery.data?.skills ?? [];
  return (
    <SettingsPageContainer>
      <SettingsSection title="Skills" icon={<FileTextIcon className="size-3.5" />}>
        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-xs text-muted-foreground">Add Markdown files to make reusable skills available to Sparky across projects. Ask Sparky to use a skill by its name; skill instructions are loaded when needed.</p>
          <label
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center transition-colors ${dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files); }}
          >
            <UploadCloudIcon className="size-6 text-muted-foreground" />
            <span className="text-sm font-medium">Drop .md files here or browse</span>
            <span className="text-xs text-muted-foreground">Files are installed in your user skills library.</span>
            <input type="file" accept=".md,text/markdown" multiple className="sr-only" onChange={(event) => { if (event.currentTarget.files) void addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
          </label>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {skillsQuery.error ? <p role="alert" className="text-xs text-destructive">Could not load skills: {skillsQuery.error}</p> : null}
          {skills.length ? <ul className="divide-y divide-border rounded-xl border border-border/70">
            {skills.map((skill) => <li key={skill.name} className="flex items-center gap-3 p-3">
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{skill.name}</p><p className="truncate text-xs text-muted-foreground">{skill.description || "No description"}</p></div>
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${skill.name}`} onClick={() => void remove(skill.name)}><Trash2Icon className="size-4" /></Button>
            </li>)}
          </ul> : <p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">No custom skills yet.</p>}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
