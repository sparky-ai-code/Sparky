# Sparky: lead list and X post bank

Prepared 2026-08-02.

## Positioning used

Sparky is a desktop coding agent for real projects. It can read a codebase, make edits, run commands, search the project, and help inspect the result in a browser. It uses the model provider/API key the developer chooses, so the product story is about a visible, local workflow and user control—not another closed code editor subscription.

## Lead strategy

The best early leads are people already feeling one of these pains:

1. “My AI coding workflow is spread across a terminal, editor, browser, and file manager.”
2. “I want agent help, but I need to see what it reads, changes, and runs.”
3. “I do not want to pay for a second model subscription or lock myself into one provider.”
4. “I am building a real product and need a fast way to iterate without losing control of the repo.”

Do not spray links into communities. Reply to a relevant post, answer the technical question first, and only share Sparky when it genuinely fits. Log the public post URL, date, topic, and next step. Do not collect private emails or scrape personal data.

## Priority leads and channels

| Priority | Lead / channel | Public source | Why it fits | First move |
|---|---|---|---|---|
| A | Product Hunt makers in AI Coding Agents | [Product Hunt AI coding agent launches](https://www.producthunt.com/topics/ai-coding-agents) | These makers are actively comparing agent workflows, BYOK, desktop UX, and local-first tooling. | Comment on a recent launch with a specific workflow question; invite the maker to dogfood Sparky on the repo they are building. |
| A | Projekt maker/community | [Projekt on Product Hunt](https://www.producthunt.com/products/projekt-design-engineered) | Adjacent BYOK workspace; its launch copy explicitly calls out terminal/browser/file-manager context switching. | Offer a workflow comparison or integration conversation, not a generic promotion. |
| A | Mozzie maker/community | [Mozzie on Product Hunt](https://www.producthunt.com/products/mozzie) | Local-first desktop orchestration for developers already running multiple agents. | Ask what they use for single-project read/edit/run/review work between parallel jobs. |
| A | VEXI maker/community | [VEXI on Product Hunt](https://www.producthunt.com/products/vexi) | Open-source, multi-provider, privacy-friendly coding agent audience. | Respond to the maker’s “agent proposes, human stays in control” angle with a concrete review workflow. |
| A | Osaurus maker/community | [Osaurus on Product Hunt](https://www.producthunt.com/products/osaurus) | Open-source, native, local-first agent users care about ownership, approval gates, and no lock-in. | Start a respectful conversation around code review visibility and provider choice. |
| A | Billy.sh maker/community | [Billy.sh on Product Hunt](https://www.producthunt.com/products/billy-sh) | Local coding assistant users are already motivated by privacy, cost control, and model ownership. | Ask which tasks are better in a desktop surface than a terminal; offer a side-by-side test. |
| A | ClawTab maker/community | [ClawTab on Product Hunt](https://www.producthunt.com/products/clawtab) | Developers managing many coding-agent sessions are a high-intent workflow audience. | Talk about the handoff from a long-running agent to a focused project review. |
| A | Open Computer Use MCP | [Open Computer Use on Product Hunt](https://www.producthunt.com/products/open-computer-use) | MCP and desktop-control builders are natural technical partners and early evaluators. | Propose testing Sparky’s browser inspection against a real local app. |
| A | Indie Hackers Dev Tools & APIs | [Indie Hackers tech founders](https://www.indiehackers.com/tech) | Solo founders and small teams have immediate pressure to ship, debug, and iterate. | Follow active build logs; reply with a useful debugging prompt or verification checklist before mentioning Sparky. |
| A | Indie Hackers product makers | [Indie Hackers products](https://www.indiehackers.com/products) | Every launched product is a potential user with a live repo and limited engineering bandwidth. | Filter for products launched recently and target founders showing screenshots, bugs, or feature work. |
| A | Local-model developers | [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/) / [@localllamasub](https://x.com/localllamasub) | They discuss model choice, tool calling, privacy, and practical local workflows. | Join the technical conversation; lead with provider flexibility and inspectable changes, never a vague “try my app.” |
| B | Open-source maintainers | [GitHub Sponsors](https://github.com/sponsors/?locale=en-US) | Maintainers have real codebases, recurring maintenance tasks, and a strong interest in transparent tooling. | Find maintainers who publicly discuss release chores or issue triage; offer a small workflow test. |
| B | Recurse Center builders | [Recurse Center](https://www.recurse.com/) | High-signal programmers value learning, experimentation, and thoughtful tools. | Share a short “agent workflow with verification” experiment where community rules allow it. |
| B | Privacy-first coding tools | [GlassCode](https://glasscode.dev/), [Quietly](https://www.quietlycode.org/), [Happier](https://happier.dev/) | Adjacent products reveal users who care about local execution, privacy, and control. | Treat as partnership/listening leads. Ask what users still do manually after the agent finishes. |
| B | AI coding tool directories and launch newsletters | [Product Hunt developer tools](https://www.producthunt.com/topics/developer-tools) | Curators and reviewers can create durable discovery if they understand the distinction between an agent and an editor. | Pitch a focused demo: prompt → files read → diff → test → browser result. |
| B | Rust desktop developers | [Rust community](https://www.rust-lang.org/community) | Sparky’s local desktop and systems-oriented workflow is relevant to Rust builders and tool makers. | Participate in technical discussions about local apps, PTY behavior, packaging, and safe command execution. |
| C | Small web agencies and freelance developers | Public X searches for “client project”, “bugfix”, “shipping SaaS”, and “indie hacker” | They repeatedly move between client repos, local previews, and release checks. | Publish a practical workflow post and invite replies from people who want the checklist. |
| C | Bootcamp graduates and career-switchers building portfolios | Public build-in-public posts and local meetups | They need explanation plus execution, not just autocomplete. | Use educational posts: how to ask for a change, inspect a diff, and verify the result. |

### Search strings to use manually on X

Use these as search prompts, then engage only with recent, clearly relevant posts:

- `("AI coding" OR "coding agent") (local OR desktop OR BYOK OR privacy)`
- `("building in public" OR indie hacker) (bug OR refactor OR deploy OR SaaS)`
- `("Claude Code" OR Codex OR Gemini CLI OR OpenCode) (workflow OR terminal OR browser)`
- `(MCP OR "model context protocol") (developer tool OR local app OR browser)`
- `(open source OR self-hosted) (coding assistant OR developer tool)`

### Simple qualification score

- +3: person is actively building or maintaining a real repo.
- +2: they mention switching between terminal/editor/browser or reviewing agent changes.
- +2: they mention BYOK, privacy, local models, or provider lock-in.
- +1: they ask for tool recommendations or workflow feedback.
- -3: obvious engagement bait, giveaway account, or generic AI-content farm.
- -5: no evidence they build software.

Start with scores of 6+. Aim for 5 thoughtful conversations a day, not mass replies.

## Personal account posts

Voice: first person, specific, a little opinionated, curious. Add a real detail or screenshot before publishing when possible.

### Build log / founder voice

1. I keep coming back to the same product question: when an agent changes a codebase, how much of the work should stay visible? For Sparky, the answer is: the files it read, the diff it made, the commands it ran, and the result.

2. The best coding-agent demo is not “look, it wrote code.” It is “look, it found the right files, made a small change, ran the check, and showed me what happened.”

3. Building a desktop coding agent has made me appreciate boring details: paths, permissions, terminal output, failed builds, and the 4th time a local server refuses to start. That is where trust is earned.

4. A beautiful chat box is easy to demo. The harder part is helping someone get from “please fix this” to a reviewed change they are comfortable keeping.

5. We are trying to make the workflow feel less like magic and more like a good teammate: explain the plan, touch the smallest surface, run the check, show the evidence.

6. One thing I do not want from coding tools: a confident answer with no trail. If a change matters, I want to see what led to it.

7. The humble project folder is still the center of most software work. The best tools meet developers there instead of asking them to rebuild their entire workflow around a new tab.

8. “Can it use my model?” is a much better product question than “which model does it use?” Developers already have preferences, budgets, and accounts. The tool should respect that.

9. A good agent workflow has a natural rhythm: ask, inspect, change, run, review. If one of those steps disappears, the user usually pays for it later.

10. The future of coding tools probably looks less like one giant editor and more like a set of small, well-connected surfaces that keep the work understandable.

### Questions and conversation starters

11. What is the first thing you check after an AI coding tool says “done”? Tests? Diff? Browser? Git status? Something else?

12. Which part of coding with an agent still feels unnecessarily manual: getting context in, reviewing edits, running commands, or checking the result?

13. Do you prefer a coding agent in the terminal, inside an editor, or in a separate desktop app? I am genuinely curious what makes one feel more trustworthy.

14. What is one task you would happily hand to an agent, but only if it showed every step?

15. Provider choice: important freedom, or just another setup decision? I keep hearing both answers.

16. What is the smallest useful change an agent has made in your project recently?

17. If your coding agent could only improve one thing tomorrow, would you pick better context, better edits, better tests, or better explanations?

18. What makes you stop trusting an agent? A wrong file, a skipped test, a vague summary, or something else?

19. Honest question for people building with local models: is the biggest friction model quality, setup, tool calling, or the surrounding workflow?

20. When you say “the agent understands my repo,” what evidence do you actually want to see?

### Practical mini-lessons

21. A useful coding-agent prompt usually has four parts: the intent, the constraints, the relevant area, and how to verify the result. “Make it better” is a wish. “Change X in Y, preserve Z, then run Q” is a task.

22. The safest refactor is usually the smallest one that proves the idea. Ask the agent to inspect first, name the files it expects to touch, then apply the change.

23. If an agent gets stuck, do not just repeat the prompt louder. Give it the error, the command that produced it, what you expected, and what you already tried.

24. Browser checks are underrated. A green test suite can coexist with a broken layout, missing loading state, or a button that only works in your imagination.

25. Before asking an agent to “clean up the code,” decide what clean means: fewer branches, clearer names, less duplication, smaller files, or better tests. Specificity saves cycles.

26. My preferred definition of done: the change exists, the diff is understandable, the relevant check ran, and the result was inspected where a user would see it.

27. A model can be brilliant and still lack the one piece of context that matters. Good tooling makes it easy to point at the right project, files, command, and expected result.

28. The most useful agent summaries are not novels. They answer: what changed, why, what ran, what failed, and what I should look at next.

29. If your AI tool edits files without making review easy, it is saving keystrokes while adding uncertainty. That is a bad trade.

30. A coding assistant should help you move faster without making you outsource your judgment.

### Soft product mentions

31. I have been using Sparky’s “read → edit → run → review” loop as a forcing function for product decisions. If a step is hard to explain, it probably needs to be easier to see.

32. The part of Sparky I care about most is not the prompt box. It is the handoff back to the human: here is the diff, here is the output, here is the result.

33. Sparky is for the moment after you have a real project open and a real problem to solve—not for generating a fake app in a blank demo.

34. If you already have a model provider you like, Sparky is designed to work with that choice. Your workflow should not be held hostage by one model menu.

35. We are looking for developers who will use Sparky on an imperfect, active project and tell us where the workflow breaks. The rough edges are the useful feedback.

## Sparky business account posts

Voice: clear, useful, product-led. Do not overuse hashtags. Link to the product/docs only when the post earns the click.

### Product and workflow

1. Sparky is a desktop coding agent for real projects: read the codebase, make the change, run the command, review the result.

2. Open a project. Describe the task. Sparky explores the structure before changing files, then gives you a visible trail of the work.

3. Your codebase is not a blank canvas. Sparky starts from the project you already have and helps you move it forward.

4. Coding agents are more useful when you can inspect the work as it happens. Sparky keeps the important steps in view: files, edits, commands, and results.

5. A coding agent should not make “done” a black box. Sparky helps you review the change before you ship it.

6. Use the AI provider you already work with. Sparky is built around choice, not a forced model subscription.

7. From a failing test to a reviewed fix: Sparky keeps the loop close to the project instead of scattering it across tabs.

8. Need to check the result in the browser? Sparky can help you inspect the page after the code changes, so “works” means more than “the model said so.”

9. The shortest path from idea to shipped change is not always more automation. Sometimes it is better visibility at each step.

10. Sparky is for developers who want agent speed and human control in the same workflow.

### Educational posts

11. Prompt pattern: “Inspect the project first. Change only the files needed. Preserve [constraint]. Run [check]. Summarize the diff and any remaining risk.”

12. Before a refactor, ask the agent to identify the files and assumptions it will use. That one pause can prevent a lot of cleanup later.

13. When debugging, include the exact command, exact error, expected behavior, and what changed recently. Better input usually beats a longer prompt.

14. Review checklist: Did the change touch the right files? Is the diff smaller than it needs to be? Did the relevant check run? Did the user-visible result change as intended?

15. “Make the UI nicer” is not a great task. “Increase contrast, preserve the layout, keep mobile behavior, then inspect the settings screen” is much easier to verify.

16. Ask for a plan before a multi-file change. You are not slowing the agent down; you are reducing rework.

17. A failed command is useful context. Keep the output, explain the expected result, and let the next attempt build on evidence instead of guesses.

18. Tests answer some questions. A browser preview answers others. Use both when the change has a user-facing effect.

19. The right amount of context is not “everything.” It is the project area, the intent, the constraints, and the proof you need at the end.

20. The agent proposes. You decide. The diff is where that collaboration becomes concrete.

### Conversation and community

21. What do you want to see before accepting an agent-made change: a diff, test output, screenshots, a plain-English summary, or all of the above?

22. Terminal, editor, or desktop app: where does your coding-agent workflow feel most natural today?

23. What is the most annoying context switch in your current development loop?

24. Which model provider do you reach for most often when coding, and what makes it the right fit for you?

25. What is one repetitive task in your repo you would delegate immediately if the verification step were obvious?

26. Show us a screenshot of the messiest part of your current AI coding workflow. We are collecting problems, not polished demos.

27. What should a coding agent never do without asking first?

28. Do you review every agent diff, or only the risky ones? No wrong answer—we want to understand real workflows.

29. If you could remove one tab from your development setup, which one would it be?

30. What makes a developer tool feel trustworthy to you after the first five minutes?

### Launch, docs, and CTA posts

31. New to Sparky? Start with a small, real task in a project you understand. Ask for the change, inspect the diff, run the check, and see how the loop feels.

32. Sparky works best when you give it something real to do: a bug, a failing check, a rough screen, a confusing file, or a feature that needs a first pass.

33. We are building Sparky around a simple idea: the faster the tool works, the more important it is that the work stays understandable.

34. Bring a project, a model provider, and a task. Sparky brings the desktop workflow for reading, editing, running, and reviewing.

35. If your current coding-agent setup feels like terminal + editor + browser + file manager + guesswork, Sparky is worth a look.

36. We do not need another demo where an agent creates a todo app from nothing. Give Sparky the half-finished project, the stubborn bug, or the UI you are afraid to touch.

37. Try this task: “Find the code responsible for [behavior]. Explain the current flow. Propose the smallest fix. Run the relevant check. Show me the diff.”

38. Sparky’s docs are written for the moment you are actually stuck: connecting a provider, choosing a model, giving a useful task, and checking the result.

39. A visible workflow is a feature. If you want to know what Sparky read, changed, and ran, the answer should be close at hand.

40. We are looking for early users with real repos and honest feedback. If you build software and care about seeing the work, say hello.

## Authenticity guardrails

## Corrected browser post

Use with `sparky-website/assets/sparky-demo-browser.png`:

> Introducing Sparky’s Built-In Browser, Your Coding Agent’s Window Into the Web.
> Open your local app or a live URL, inspect the result, and point Sparky at exactly what you want changed.
> If you haven’t already, come try it at: sparky.llc

- These drafts are original and varied, but no one can guarantee how a platform classifier will label any post.
- Add a real detail before posting: the project type, the actual command, a screenshot, a short screen recording, or what you learned that day.
- Keep the personal account personal. Do not copy the business post word-for-word.
- Avoid fake urgency, fake customer quotes, fabricated metrics, and generic “revolutionizing the future” language.
- Use 0–2 hashtags only when they help discovery; most posts should have none.
- Do not post the same idea from both accounts on the same day. Reframe it: personal account = observation or question; business account = workflow or product explanation.
- Space promotional posts between useful observations and replies. A practical default is 3 useful posts for every 1 direct product post.
- For lead outreach, disclose the relationship when relevant and respect community rules.
