# permissions

Tiered approval policy and the deny rules nothing overrides.

## The model

Three tiers, evaluated in order:

1. **Category deny rules** — `rm -rf`, `git checkout -- .`, `git reset --hard`, fork bombs. Checked first and nothing overrides them: not a session grant, not a classifier, not the user in a hurry.
2. **Auto-allowed kinds** — `read` and in-workspace `write` tools never prompt.
3. **Everything else asks**, once, with `allow-session` available.

## Why this shape

Anthropic measured users approving **93% of permission prompts**. A gate passing 93% of traffic carries no information and trains reflexive approval. Their answer was tiering plus a model classifier; the classifier still misses **17%** of genuinely overeager actions.

That number is the argument for building the deny rails and the undo path first, and a classifier later on top — never the reverse. Phase 1 stops at static tiers deliberately.

## Rules

**Approval policy is not the security boundary.** The sandbox and the tool registry are. This layer is usability on top of containment; if the sandbox is off, this prompts but does not protect.

**`describeRadius` output is shown before the prompt.** Users need legible blast radius, not a yes/no question about a tool name. Keep it factual and complete.

**Deny rules are patterns over the command string.** They are a backstop, not a parser. A determined model can evade them; the sandbox is what actually holds.
