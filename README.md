# swamp-version

Swamp extension that reports how far a swamp install has drifted behind the
published channel — for a local binary, a container, or a host over SSH.

Read-only. It never updates, installs, or restarts anything.

| Extension               | Type   | Docs                                                     |
| ----------------------- | ------ | -------------------------------------------------------- |
| `@sntxrr/swamp-version` | models | [extensions/models/README.md](extensions/models/README.md) |

## Quick start

```bash
swamp extension pull @sntxrr/swamp-version

swamp model create @sntxrr/swamp-version/target swamp-serve \
  --global-arg probe=docker \
  --global-arg container=swamp-serve \
  --global-arg dockerContext=np-docker

swamp model @sntxrr/swamp-version/target method run drift swamp-serve
```

## Development

```bash
~/.swamp/deno/deno check extensions/models/swamp_target.ts
~/.swamp/deno/deno test --allow-all extensions/models/swamp_target_test.ts
swamp extension quality extensions/models/manifest.yaml --json
```

## License

MIT
