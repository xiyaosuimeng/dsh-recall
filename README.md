# dsh-recall

A DSH plugin that appends relevant past memories to the tail of each turn.

## What it does

Before a turn starts, a retrieval script is run against the user message.
Matching memory snippets are appended to the **tail** of the message list,
never to the system prompt — so the cached prefix stays byte-identical.

- Default mode is `dryRun`: it only logs what would be injected.
- Retrieval is delegated to an external script, so you can plug in keyword
  search, BM25, embeddings, or anything else.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `DSH_RECALL_SCRIPT` | `recall_once.py` | Retrieval script; prints snippets to stdout |
| `DSH_RECALL_LOG` | `recall_plugin.log` | Log file path |

Plugin config (`cordis.patch.yml`):

```yaml
- id: dsh-recall
  config:
    dryRun: true
    script: recall_once.py
    maxSnippets: 3
```

## Retrieval script contract

The script is called with the user message as its argument and must print
the passages to inject, one per block. Empty output means "nothing relevant".

A reference implementation (`recall_once.py`) is included.

## Installation

Copy this directory into your DSH plugins folder, then enable it in
`cordis.patch.yml`.

## License

MIT
