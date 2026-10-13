# demarker

CLI for [Demarker](https://demarker.io): see what an AI image carries, then clean it.

```bash
npx demarker identify image.png        # free, no account or key needed
export DEMARKER_API_KEY=sk_live_...    # create at https://demarker.io/app/settings/api
npx demarker clean image.png --max-credits 1 --attest-rights
```

Commands: `identify`, `clean`, `balance`, `pricing`, `login`, `logout`. Run `demarker --help`.

- `clean` needs `--max-credits`: nothing is charged if the quote is over it.
- You must confirm the rights statement. On a terminal you are asked; with `--json` or no terminal, pass `--attest-rights` only if it is true.
- Results are saved as `<name>.clean.<ext>` and never overwrite a file.
- `--json` prints machine-readable output. Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 credits, 5 rejected, 6 region blocked, 7 job failed, 8 network.
- Config: `DEMARKER_API_KEY`, `DEMARKER_API_URL`, or `demarker login` (stored in `~/.config/demarker`, mode 600).

Also: [`@demarker/mcp`](https://www.npmjs.com/package/@demarker/mcp) for Claude, Cursor and other MCP clients.
