# pi-ext

My collection of [pi](https://github.com/badlogic/pi-mono) coding-agent
extensions.

Each extension is a **self-contained npm package** under `packages/` —
published to npm independently, tested together.

## Extensions

| Package | npm | What it does |
|---|---|---|
| [`pi-qq`](packages/pi-qq) | [`@elvinw/pi-qq`](https://www.npmjs.com/package/@elvinw/pi-qq) | `/qq` — ask a side question that never pollutes your main conversation context (Claude Code's `/btw`, for pi). |

## Layout

```
pi-ext/
├── packages/            # one self-contained npm package per extension
│   └── pi-qq/           #   extensions/ + test/ + package.json  ->  published to npm
├── package.json         # private root: npm workspaces + fan-out scripts
├── tsconfig.base.json   # shared compilerOptions
└── .github/workflows/   # ci.yml (combined test)  .  publish.yml (per-extension)
```

## Road signs

### Test everything (one command)
```bash
npm install
npm test            # fans out to every package under packages/
npm run typecheck
```

### Publish one extension
Tag its package dir + version, then push the tag:
```bash
git tag pi-qq/v0.5.7 && git push origin pi-qq/v0.5.7
```
CI verifies the tag matches the package's `version`, runs that package's
typecheck + tests, and publishes with provenance. Any other tag is a no-op —
so every extension publishes **independently** off one shared workflow.

### Add a new extension
Drop a self-contained package at `packages/<name>/`: an `extensions/` dir of
`.ts` files, a `test/` dir, and a `package.json` named `@elvinw/pi-<name>`.
npm workspaces picks it up automatically — combined tests include it for free,
and it publishes via `<name>/v<version>`. Use [`packages/pi-qq`](packages/pi-qq)
as the reference.

## License

MIT — see [LICENSE](LICENSE).
