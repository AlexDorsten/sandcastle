---
"@ai-hero/sandcastle": patch
---

Fix managed worktree reuse on macOS when git canonicalizes paths under `.sandcastle/worktrees`, and keep source checkouts typecheckable without installing the optional `@daytona/sdk` peer.
