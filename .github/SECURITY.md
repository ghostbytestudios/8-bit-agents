# Security policy

8Bit Agents runs AI agents that can read and write files and run commands on your computer, so we take
security reports seriously.

## Reporting a problem

Please **don't** open a public issue. Report it privately instead:

- [Report a vulnerability on GitHub](https://github.com/ghostbytestudios/8-bit-agents/security/advisories/new), or
- email ghxstbytestudios@gmail.com with "Security" in the subject.

Say what you found, the version (it's in the **About** window), your system, and the steps to reproduce
it. We'll reply within a week, keep you updated while we work on a fix, and credit you in the release
notes unless you'd rather we didn't.

## Supported versions

Only the newest release gets security fixes. The app checks for updates on its own, and
**Help › Check for Updates** checks right away.

## What counts

We especially want to hear about anything that lets:

- an agent read or write outside the workspace folder you chose
- a shell command run without your OK in the inbox
- an API key leave your computer for anywhere except its provider
- a web page or another program on your computer control the local agent server
- a run carry on past its spending limit

Problems in a model provider's own service should go to that provider.
