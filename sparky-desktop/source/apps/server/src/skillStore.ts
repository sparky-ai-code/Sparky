// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Skill, SkillDeleteInput, SkillError, SkillListResult, SkillSaveInput } from "@sparky/contracts";

type SkillStore = {
  readonly list: () => Effect.Effect<SkillListResult, SkillError>;
  readonly save: (input: SkillSaveInput) => Effect.Effect<Skill, SkillError>;
  readonly remove: (input: SkillDeleteInput) => Effect.Effect<{ deleted: boolean }, SkillError>;
};

export class SkillStoreService extends Context.Service<SkillStoreService, SkillStore>()(
  "t3/skillStore/SkillStoreService",
) {}

const skillRoot = () =>
  process.env.SPARKY_SKILLS_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".agents", "skills");
const safeName = (name: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
const isManagedSkillFile = (content: string) => {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  return /^metadata:\r?\n  sparkyManaged: "true"$/m.test(frontmatter);
};
const makeError = (operation: string, cause: unknown) =>
  new SkillError({
    operation,
    message: cause instanceof Error ? cause.message : "Could not access skills.",
  });

const make = Effect.succeed({
  list: () =>
    Effect.tryPromise({
      try: async () => {
        const root = skillRoot();
        const entries = await NodeFS.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        const skills = (await Promise.all(entries.filter((entry) => entry.isDirectory() && safeName(entry.name)).map(async (entry) => {
          try {
            const content = await NodeFS.readFile(NodePath.join(root, entry.name, "SKILL.md"), "utf8");
            if (!isManagedSkillFile(content)) return null;
            const description = content.match(/^description:\s*(.*)$/m)?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
            const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
            return { name: entry.name, description, content: body };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }))).filter((skill): skill is NonNullable<typeof skill> => skill !== null);
        return { skills };
      },
      catch: (cause) => makeError("list", cause),
    }),
  save: (input) =>
    Effect.tryPromise({
      try: async () => {
        if (!safeName(input.name)) throw new Error("Skill names must be lowercase letters, numbers, and hyphens.");
        if (!input.content.trim()) throw new Error("Skill content is required.");
        if (input.content.length > 100_000) throw new Error("Skill content must be under 100,000 characters.");
        const directory = NodePath.join(skillRoot(), input.name);
        const skillFile = NodePath.join(directory, "SKILL.md");
        const existing = await NodeFS.readFile(skillFile, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existing !== null && !isManagedSkillFile(existing)) {
          throw new Error(`A skill named “${input.name}” already exists and is not managed by Sparky.`);
        }
        const description = input.description.replace(/[\r\n"<>]/g, " ").trim().slice(0, 200);
        const metadata = `---\nname: ${input.name}\ndescription: "${description}"\nmetadata:\n  sparkyManaged: "true"\n---\n\n`;
        await NodeFS.mkdir(directory, { recursive: true });
        await NodeFS.writeFile(skillFile, `${metadata}${input.content.trim()}\n`, "utf8");
        return { name: input.name, description, content: input.content };
      },
      catch: (cause) => makeError("save", cause),
    }),
  remove: (input) =>
    Effect.tryPromise({
      try: async () => {
        if (!safeName(input.name)) throw new Error("Invalid skill name.");
        const directory = NodePath.join(skillRoot(), input.name);
        const skillFile = NodePath.join(directory, "SKILL.md");
        try {
          const content = await NodeFS.readFile(skillFile, "utf8");
          if (!isManagedSkillFile(content)) {
            throw new Error(`The “${input.name}” skill is not managed by Sparky.`);
          }
          await NodeFS.unlink(skillFile);
          await NodeFS.rmdir(directory).catch(() => undefined);
          return { deleted: true };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted: false };
          throw error;
        }
      },
      catch: (cause) => makeError("delete", cause),
    }),
});

export const layer = Layer.effect(SkillStoreService, make);
