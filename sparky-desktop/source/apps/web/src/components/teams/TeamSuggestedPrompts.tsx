import {
  ArchiveIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  FileIcon,
  GitBranchIcon,
  ListTodoIcon,
  MessageCircleIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "../Hugeicons";

import type { ComponentType } from "react";

import type { TeamPrompt, TeamPromptIcon } from "./teamsLogic";

const PROMPT_ICONS: Record<TeamPromptIcon, ComponentType<{ className?: string }>> = {
  "pull-request": GitBranchIcon,
  bug: CircleAlertIcon,
  checklist: ListTodoIcon,
  message: MessageCircleIcon,
  calendar: CalendarClockIcon,
  alert: TriangleAlertIcon,
  file: FileIcon,
  list: ArchiveIcon,
  users: UsersIcon,
};

interface TeamSuggestedPromptsProps {
  readonly prompts: readonly TeamPrompt[];
  readonly onPick: (prompt: string) => void;
}

export function TeamSuggestedPrompts(props: TeamSuggestedPromptsProps) {
  const { prompts, onPick } = props;

  return (
    <div className="flex flex-col items-start">
      {prompts.map((prompt) => {
        const Icon = PROMPT_ICONS[prompt.icon];
        return (
          <button
            key={prompt.text}
            type="button"
            onClick={() => onPick(prompt.text)}
            className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-[15px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0">{prompt.text}</span>
          </button>
        );
      })}
    </div>
  );
}
