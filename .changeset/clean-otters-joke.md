---
"@ai-hero/sandcastle": patch
---

Add a built-in `dockerIsolated()` sandbox provider that copies repos into Docker containers instead of bind-mounting them, which helps on macOS setups where external paths such as `/Volumes/...` are not mounted reliably by Docker Desktop.
