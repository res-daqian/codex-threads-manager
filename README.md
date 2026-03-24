# codex-thread-manager

macOS-first CLI for listing, inspecting, and deleting Codex CLI/Desktop sessions under `~/.codex`.

## Commands

Run through the wrapper:

```bash
./bin/codex-thread-manager list
./bin/codex-thread-manager list --tree fork --all
./bin/codex-thread-manager show 019d1f8c
./bin/codex-thread-manager delete 019d1f8c --dry-run
./bin/codex-thread-manager delete --all
```

## Behavior

- `list` renders an ASCII tree grouped by date or fork lineage.
- `show` prints the full normalized metadata for one session.
- `delete` removes the selected session from:
  - rollout JSONL files under `sessions/`
  - `session_index.jsonl`
  - `state_5.sqlite`
  - `logs_1.sqlite`
  - matching shell snapshots
- Active-thread deletion is refused when `CODEX_THREAD_ID` matches the target.

## Verification

```bash
npm test
```
