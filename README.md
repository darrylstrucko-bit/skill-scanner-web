# skill-scanner-web

A prototype web tool for scanning Claude Skills / OpenAI Codex skill files for security
issues, built on Cisco's open-source [Skill Scanner](https://github.com/cisco-ai-defense/skill-scanner).

## Status

Phase 1 (in progress): run locally against a handful of hand-written sample skills
(benign and deliberately malicious) with no upload surface and no sandboxing — just
proving the scanner catches what it should.

Phase 2 (planned): add upload handling, sandboxed/subprocess-isolated scanning with
timeouts and fail-closed behavior, and deploy publicly.
