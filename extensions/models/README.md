# @sntxrr/swamp-version

Read the swamp version a host or container is running, and report how far it
has drifted behind the published channel.

Read-only. It never updates, installs, or restarts anything.

## Why this exists

`swamp update --check` answers the question for the binary invoking it, on the
platform invoking it. That is no help when the install you care about is a
pinned binary inside a container on another host — which is exactly the install
most likely to go stale, because nothing auto-updates it.

## Model type

`@sntxrr/swamp-version/target`

| Method  | Does                                                                        |
| ------- | --------------------------------------------------------------------------- |
| `sync`  | Record the version and platform a target reports about itself                |
| `drift` | Compare that against the newest build published on a channel for its platform |

## Usage

A container on another docker host:

```bash
swamp model create @sntxrr/swamp-version/target swamp-serve \
  --global-arg probe=docker \
  --global-arg container=swamp-serve \
  --global-arg dockerContext=np-docker

swamp model @sntxrr/swamp-version/target method run drift swamp-serve
```

The binary on this machine:

```bash
swamp model create @sntxrr/swamp-version/target laptop --global-arg probe=local
swamp model @sntxrr/swamp-version/target method run drift laptop
```

A host over SSH:

```bash
swamp model create @sntxrr/swamp-version/target buildbox \
  --global-arg probe=ssh --global-arg host=buildbox
```

## Global arguments

| Argument          | Default                            | Notes                                                       |
| ----------------- | ---------------------------------- | ----------------------------------------------------------- |
| `probe`           | required                           | `local`, `docker`, or `ssh`                                  |
| `container`       | —                                  | Required for `probe=docker`                                  |
| `dockerContext`   | active context                     | Lets one host check a container on another                   |
| `host`            | —                                  | Required for `probe=ssh`                                     |
| `binary`          | `swamp`                            | Path to the binary on the target                             |
| `platform`        | detected with `uname`              | e.g. `linux-x86_64`. Detection is almost always what you want |
| `channel`         | `stable`                           | Channel alias to resolve                                     |
| `artifactBaseUrl` | `https://artifacts.swamp-club.com` | Override only for a mirror                                   |
| `verifyArtifact`  | `true`                             | HEAD the resolved archive to confirm it is fetchable         |
| `label`           | derived                            | Short stable name used in resource names                     |
| `timeoutMs`       | `15000`                            | Per probe command and per HTTP call                          |

## The field to alert on

`drift.behind`. Everything else is context:

```bash
swamp data get drift-np-docker-swamp-serve --json | jq '{
  status, runningVersion, latestVersion, hoursBehind, artifactUrl
}'
```

## Four behaviours worth knowing

**The channel is resolved by HEAD, never by download.** The published `stable`
object is a redirect stub; a HEAD returns 200 with the resolved version in its
`x-amz-meta-x-amz-website-redirect-location` header. One request instead of the
~90 MB the archive weighs.

**Resolving the version and proving the build is possible are the same check.**
A version is only useful if the archive for the *target's* platform exists.
Pinning a rebuild to a version whose `linux/x86_64` archive is missing produces
a build that fails on download, long after the decision to upgrade was made. So
`drift` resolves the platform-specific URL, verifies it, and reports it.

**Versions are compared numerically.** The format is `YYYYMMDD.HHMMSS.N`. The
date and time are zero-padded and happen to sort correctly as text, but `N` is
not. The day a tenth build ships, `20260808.001107.10` sorts *below* `...9` as a
string, and the check reports an outdated target as current.

**`hoursBehind` is a lag, not a build count.** Swamp publishes no release list,
so the builds in between cannot be enumerated. What can be read is the timestamp
embedded in each version, and the gap between them is a real measure of
staleness. The field is named and documented for what it is.

## Failure is never "current"

An unreachable target, an unparseable version at either end, a channel alias
that answers without its redirect header, and a resolved archive that 404s are
all raised as errors. A drift check that reports "up to date" when it has
stopped working is worse than no check at all.

## License

MIT
