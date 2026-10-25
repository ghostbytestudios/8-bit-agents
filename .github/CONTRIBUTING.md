# Contributing to 8Bit Agents

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/ghostbytestudios/8-bit-agents/issues/new/choose) and pick a template.
For a bug, say which version you have (it's in the **About** window), your system, and the steps that
cause it. **Help › Open Error Log** shows the log. Remove API keys and private paths before you paste it.

Found a security problem? Please don't open a public issue. See the [security policy](SECURITY.md).

## Working on the code

Needs Node 24 or newer.

```bash
npm install
npm run dev        # the office in your browser, at http://localhost:5173
npm run server     # the local agent server, on 127.0.0.1:8787
```

Open `http://localhost:5173/?mock` to watch pretend agents without a server or an API key. You don't need
a paid key to work on most of the app.

Before you open a pull request:

```bash
npm run typecheck
npm test
```

CI runs both on Windows and Linux for every pull request.

## Pull requests

- Keep each pull request to one change, and explain what it changes and why.
- Add or update tests for new behaviour.
- Match the style of the code around your change.
- Write commit messages as `type: what changed`, for example `fix: stop the Boss walking through walls`.
  Types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf` and `ci`.
- For a big change, open an issue first so we can agree on the approach before you spend the time.

## Licence

8Bit Agents is licensed under the [GNU General Public License v3.0 or later](../LICENSE). By sending a pull
request, you agree that your contribution is released under the same licence.

Art and models in `apps/client/public/assets/` keep their own licences, listed in `CREDITS.json`. Only
add assets whose licence allows them to be shared in a public repository.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
