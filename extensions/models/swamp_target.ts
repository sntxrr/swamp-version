/**
 * Swamp version target — read the swamp version a host or container is running
 * and report how far it has drifted behind the published channel.
 *
 * Three read-only methods. `sync` records what a target reports about itself:
 * the swamp version it runs and the platform it runs on. `drift` resolves the
 * newest build published for that platform and reports whether the target is
 * behind it. `repoDrift` covers the second, independent axis — the git
 * checkout a `swamp serve` target serves — because a container can run the
 * newest binary while serving a checkout weeks behind its branch, and the
 * binary check reports `current` throughout.
 *
 * This exists because swamp's own version is the one thing swamp had no model
 * for. `swamp update --check` answers the question for the binary invoking it,
 * on the platform invoking it — which is no help when the install you care
 * about is a pinned binary inside a container on another host.
 *
 * Four behaviours worth reading before use, each driven by how the real
 * artifacts behave rather than by taste:
 *
 * 1. **The channel alias is resolved by HEAD, never by download.** The
 *    published `stable` object is a redirect stub: a HEAD returns 200 with the
 *    resolved version in `x-amz-meta-x-amz-website-redirect-location`. Reading
 *    that header costs one request instead of the ~90 MB the archive weighs.
 *
 * 2. **Resolving the version and proving the build is possible are the same
 *    check.** A version is only useful here if the artifact for the *target's*
 *    platform exists — pinning a rebuild to a version whose `linux/x86_64`
 *    archive is missing produces a build that fails on download. `drift`
 *    therefore resolves and verifies the platform-specific URL, and reports it.
 *
 * 3. **Versions are compared numerically, never as strings.** The format is
 *    `YYYYMMDD.HHMMSS.N`, whose date and time components are zero-padded and so
 *    happen to sort correctly as text — but `N` is not padded. The day a
 *    tenth build ships, `20260808.001107.10` sorts *below* `...9` as a string
 *    and the check silently reports an outdated target as current. Numeric
 *    comparison costs nothing and removes the trap entirely.
 *
 * 4. **`hoursBehind` is a lag, not a build count.** There is no release-list
 *    API for swamp the way there is for a GitHub project, so this model cannot
 *    enumerate the builds it missed. What it can do is read the timestamp
 *    embedded in each version and report the gap. That is a genuine measure of
 *    staleness and it is honest about what it is not.
 *
 * Every failure to *establish* a comparison — an unreachable target, an
 * unparseable version at either end, a channel alias that answers without a
 * redirect header — is raised rather than folded into a reassuring `current`.
 * A drift check that quietly reports "up to date" when it has stopped working
 * is worse than no check at all.
 *
 * @module
 */
// extensions/models/swamp_target.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  probe: z.enum(["local", "docker", "ssh"]).describe(
    "How to reach the target: run the binary here (`local`), inside a container (`docker`), or over SSH (`ssh`).",
  ),
  container: z.string().optional().describe(
    "Container name for the `docker` probe, e.g. swamp-serve.",
  ),
  dockerContext: z.string().optional().describe(
    "Docker context to run against, e.g. np-docker. Omit to use the active context. Lets one host check a container on another without SSHing itself.",
  ),
  host: z.string().optional().describe(
    "SSH destination for the `ssh` probe, e.g. docker or user@host. Uses your SSH config.",
  ),
  binary: z.string().default("swamp").describe(
    "Name or path of the swamp binary on the target. Override when it is not on PATH.",
  ),
  platform: z.string().optional().describe(
    "Artifact platform to compare against, e.g. linux-x86_64 or darwin-aarch64. Detected from the target with `uname` when omitted — which is almost always what you want, since comparing a container against the checking host's platform is the mistake this field exists to prevent.",
  ),
  channel: z.string().default("stable").describe(
    "Published channel alias to resolve, as used by install.sh. `stable` unless you deliberately track another.",
  ),
  artifactBaseUrl: z.string().url().default(
    "https://artifacts.swamp-club.com",
  ).describe("Artifact host. Override only for a mirror."),
  verifyArtifact: z.boolean().default(true).describe(
    "After resolving the channel, HEAD the resolved platform-specific archive to confirm it is actually fetchable. This is the precondition for pinning a rebuild to it; turning it off saves one request and gives up that guarantee.",
  ),
  label: z.string().optional().describe(
    "Short stable name for this target in resource names. Derived from the probe settings when omitted.",
  ),
  timeoutMs: z.number().int().positive().default(15000).describe(
    "Abort each probe command and each HTTP call after this long. A drift check must never hang a workflow.",
  ),
  repoDir: z.string().default("/data/repo").describe(
    "Path INSIDE the target to the git checkout `swamp serve` runs from. Only used by `repoDrift`.",
  ),
  repoRef: z.string().default("main").describe(
    "Branch the deployment tracks. `repoDrift` compares the checkout against `origin/<repoRef>`.",
  ),
  repoFetch: z.boolean().default(true).describe(
    "Run `git fetch` before comparing, so `origin/<repoRef>` reflects the real remote. Leaving this off compares against whatever the target last fetched — which is exactly the stale reading that makes a behind container look current. Turn it off only when the target has no network or no credential.",
  ),
  execEnv: z.record(z.string(), z.string()).optional().describe(
    "Environment variables to set for probe commands. The motivating case is `GIT_SSH_COMMAND`: a container's entrypoint may export it in-process, in which case `docker exec` does NOT inherit it and git fetch fails `Permission denied (publickey)` even though the deploy key is fine. Set it here to reproduce the credential the target itself uses.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const TargetSchema = z.object({
  label: z.string().describe("Stable identifier for this target"),
  probe: z.string().describe("How the target was reached"),
  target: z.string().describe(
    "Human-readable description of what was probed, e.g. `docker://np-docker/swamp-serve`",
  ),
  version: z.string().describe("Swamp version the target reports running"),
  builtAt: z.string().describe(
    "Build time embedded in that version, as ISO 8601 UTC",
  ),
  platform: z.string().describe(
    "Artifact platform of the target, e.g. linux-x86_64",
  ),
  checkedAt: z.string(),
});

const DriftSchema = z.object({
  label: z.string(),
  target: z.string(),
  platform: z.string().describe("Platform whose channel was resolved"),
  channel: z.string().describe("Channel alias that was resolved"),
  runningVersion: z.string().describe("Version the target reports"),
  latestVersion: z.string().describe(
    "Newest version published on this channel for this platform",
  ),
  status: z.enum(["current", "behind", "ahead"]).describe(
    "`ahead` means the target runs something newer than the channel — normal on a prerelease or a locally built binary",
  ),
  behind: z.boolean().describe(
    "True when a newer build exists on the channel. The single field to alert on.",
  ),
  hoursBehind: z.number().describe(
    "Hours between the running build and the latest, from the timestamps embedded in each version. Zero unless status is `behind`. A measure of lag, NOT a count of missed builds — swamp publishes no release list, so the builds in between cannot be enumerated.",
  ),
  runningBuiltAt: z.string(),
  latestBuiltAt: z.string(),
  artifactUrl: z.string().describe(
    "Resolved platform-specific archive for latestVersion. This is the exact URL a pinned rebuild would download.",
  ),
  artifactVerified: z.boolean().describe(
    "Whether that URL was confirmed fetchable. False means verifyArtifact was off, not that the check failed — a failed check throws.",
  ),
  checkedAt: z.string(),
});

/**
 * Repo-content drift: the OTHER axis on which a `swamp serve` install goes
 * stale, and the one nothing else watches.
 *
 * A container can be running the newest published binary — `drift` says
 * `current`, every healthcheck is green — while the git checkout it serves is
 * weeks behind the branch it tracks, because the entrypoint fetches at boot
 * only and nothing restarts it. The two axes move independently and neither
 * implies the other.
 */
const RepoDriftSchema = z.object({
  label: z.string(),
  target: z.string(),
  repoDir: z.string().describe(
    "Checkout inspected, as a path inside the target",
  ),
  ref: z.string().describe("Remote branch compared against, e.g. origin/main"),
  deployedSha: z.string().describe("Full commit the target currently serves"),
  deployedShortSha: z.string(),
  remoteSha: z.string().describe(
    "Full commit at the tip of the tracked branch",
  ),
  remoteShortSha: z.string(),
  status: z.enum(["current", "behind", "ahead", "diverged"]).describe(
    "`ahead` means the checkout carries commits the branch does not — a hand-edit in the container, since a deployment artifact should never be ahead. `diverged` means both sides have commits the other lacks, which a `reset --hard` on the next boot will silently discard.",
  ),
  behind: z.boolean().describe(
    "True when the tracked branch has commits the target has not deployed. The single field to alert on — true for `behind` AND `diverged`, because both mean undeployed work.",
  ),
  commitsBehind: z.number().describe(
    "Exact commit count the target is missing. Unlike the binary axis this IS enumerable, because git has the list.",
  ),
  commitsAhead: z.number().describe(
    "Commits present in the checkout but not on the branch. Non-zero means someone edited inside the target; a restart discards them.",
  ),
  hoursBehind: z.number().describe(
    "Hours between the deployed commit and the branch tip, by committer date. Zero when not behind.",
  ),
  deployedCommittedAt: z.string(),
  remoteCommittedAt: z.string(),
  fetched: z.boolean().describe(
    "Whether a fetch ran first. False means the comparison used the target's last-known remote state and may understate the drift.",
  ),
  checkedAt: z.string(),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type Context = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/* ------------------------------------------------------------------ *
 * Version handling
 *
 * Swamp versions look like `20260808.001107.0-sha.71792d3a`:
 * a UTC build date, a build time, an ordinal within that build, and the
 * commit it came from. The ordinal is the reason this is parsed rather
 * than string-compared -- see the module docs.
 * ------------------------------------------------------------------ */

/** A parsed swamp version. `sha` is null when the version carries no commit. */
export type ParsedVersion = {
  /** Build date as YYYYMMDD, e.g. 20260808 */
  date: number;
  /** Build time as HHMMSS, e.g. 1107 for 00:11:07 */
  time: number;
  /** Ordinal within that build. NOT zero-padded — the reason for numeric compare. */
  build: number;
  sha: string | null;
};

/**
 * Strip ANSI escape sequences.
 *
 * `swamp --version` renders its version in colour. Piped output usually
 * arrives clean, but "usually" is not a property worth depending on when the
 * consequence is an unparseable version aborting a scheduled check.
 */
export function stripAnsi(raw: string): string {
  // deno-lint-ignore no-control-regex
  return raw.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parse a swamp version out of arbitrary command output.
 *
 * Scans for the version pattern rather than requiring the whole string to be
 * one, so it works on `swamp --version` output directly — banner, colour and
 * all — without depending on the exact phrasing of a line that is not a
 * documented interface.
 *
 * @param raw Any text expected to contain a version.
 * @returns The parsed version, or null if no version is present.
 */
export function parseSwampVersion(raw: string): ParsedVersion | null {
  const match = stripAnsi(raw).match(
    /(\d{8})\.(\d{6})\.(\d+)(?:-sha\.([0-9a-fA-F]+))?/,
  );
  if (!match) return null;

  return {
    date: parseInt(match[1], 10),
    time: parseInt(match[2], 10),
    build: parseInt(match[3], 10),
    sha: match[4] ? match[4].toLowerCase() : null,
  };
}

/** Render a parsed version back to its canonical string form. */
export function formatVersion(v: ParsedVersion): string {
  const core = `${String(v.date).padStart(8, "0")}.${
    String(v.time).padStart(6, "0")
  }.${v.build}`;
  return v.sha === null ? core : `${core}-sha.${v.sha}`;
}

/**
 * Compare two parsed versions by precedence: date, then time, then ordinal.
 *
 * The commit sha deliberately takes no part. It identifies a build; it does
 * not order one.
 *
 * @returns Negative if a < b, positive if a > b, zero if they are the same build.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.date !== b.date) return a.date - b.date;
  if (a.time !== b.time) return a.time - b.time;
  return a.build - b.build;
}

/**
 * Convert the timestamp embedded in a version into a real instant.
 *
 * Build times are UTC. This is what makes `hoursBehind` possible without a
 * release list: the version *is* a timestamp.
 */
export function versionBuiltAt(v: ParsedVersion): Date {
  const s = String(v.date).padStart(8, "0");
  const t = String(v.time).padStart(6, "0");
  return new Date(
    Date.UTC(
      parseInt(s.slice(0, 4), 10),
      parseInt(s.slice(4, 6), 10) - 1,
      parseInt(s.slice(6, 8), 10),
      parseInt(t.slice(0, 2), 10),
      parseInt(t.slice(2, 4), 10),
      parseInt(t.slice(4, 6), 10),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Platform handling
 * ------------------------------------------------------------------ */

/**
 * Map `uname -s -m` output to the platform slug the artifact paths use.
 *
 * The artifact host names architectures `x86_64` and `aarch64`; uname on macOS
 * says `arm64` for the same silicon, and Docker says `arm64` again in a third
 * spelling. Normalising here keeps that mess in one place.
 *
 * @param uname Output of `uname -s -m`, e.g. `Linux x86_64`.
 * @returns A platform slug like `linux-x86_64`, or null if unrecognised.
 */
export function platformFromUname(uname: string): string | null {
  const parts = stripAnsi(uname).trim().split(/\s+/);
  if (parts.length < 2) return null;

  const os = parts[0].toLowerCase();
  const arch = parts[1].toLowerCase();

  const osSlug = os === "darwin" ? "darwin" : os === "linux" ? "linux" : null;
  const archSlug = arch === "x86_64" || arch === "amd64"
    ? "x86_64"
    : arch === "aarch64" || arch === "arm64"
    ? "aarch64"
    : null;

  if (osSlug === null || archSlug === null) return null;
  return `${osSlug}-${archSlug}`;
}

/** Split a platform slug into the two path segments the artifact URL uses. */
export function platformPath(platform: string): { os: string; arch: string } {
  const idx = platform.indexOf("-");
  if (idx === -1) {
    throw new Error(
      `Platform "${platform}" is not in <os>-<arch> form, e.g. linux-x86_64.`,
    );
  }
  return { os: platform.slice(0, idx), arch: platform.slice(idx + 1) };
}

/**
 * Build the artifact URL for a version (or channel alias) and platform.
 *
 * Mirrors the construction in the official install.sh exactly, including the
 * quirk that the channel alias is substituted into both the path and the
 * filename — `swamp-stable-binary-linux-x86_64.tar.gz` is a real object.
 */
export function artifactUrl(
  baseUrl: string,
  version: string,
  platform: string,
): string {
  const { os, arch } = platformPath(platform);
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/swamp/${version}/binary/${os}/${arch}/swamp-${version}-binary-${platform}.tar.gz`;
}

/* ------------------------------------------------------------------ *
 * Resource naming
 *
 * writeResource instance names share ONE flat namespace across every
 * spec, so two specs writing the same name overwrite each other on
 * disk with nothing failing at validation or in tests. Both names are
 * spec-prefixed, and a test asserts they cannot collide for any input.
 * ------------------------------------------------------------------ */

/** Reduce arbitrary text to something safe to use inside a resource name. */
export function slug(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(
    /^-|-$/g,
    "",
  ) || "target";
}

/**
 * Derive a stable label for a target from its probe settings.
 *
 * Explicit `label` always wins; this is only the fallback, and it is built to
 * stay distinct across the targets a single repo is likely to watch — the same
 * container name on two docker contexts must not collapse to one label.
 */
export function deriveLabel(globalArgs: GlobalArgs): string {
  if (globalArgs.label) return slug(globalArgs.label);

  switch (globalArgs.probe) {
    case "docker":
      return slug(
        `${globalArgs.dockerContext ?? "local"}-${
          globalArgs.container ?? "container"
        }`,
      );
    case "ssh":
      return slug(globalArgs.host ?? "ssh");
    default:
      return "local";
  }
}

/** Human-readable description of what was probed. */
export function describeTarget(globalArgs: GlobalArgs): string {
  switch (globalArgs.probe) {
    case "docker":
      return `docker://${
        globalArgs.dockerContext ?? "local"
      }/${globalArgs.container}`;
    case "ssh":
      return `ssh://${globalArgs.host}`;
    default:
      return "local";
  }
}

/** Resource name for the `target` spec. Spec-prefixed — see above. */
export function targetResourceName(label: string): string {
  return `target-${label}`;
}

/** Resource name for the `drift` spec. Spec-prefixed — see above. */
export function driftResourceName(label: string): string {
  return `drift-${label}`;
}

/* ------------------------------------------------------------------ *
 * Probing the target
 * ------------------------------------------------------------------ */

/**
 * Wrap a command in whatever transport reaches the target.
 *
 * Validates that the probe has the argument it needs, because a `docker` probe
 * with no container name would otherwise become `docker exec undefined swamp`
 * and fail with something far less useful than this message.
 */
export function transportArgv(
  globalArgs: GlobalArgs,
  cmd: string[],
  env?: Record<string, string>,
): string[] {
  const entries = Object.entries(env ?? {});

  switch (globalArgs.probe) {
    case "docker": {
      if (!globalArgs.container) {
        throw new Error(
          "probe=docker requires `container` — the name of the container to exec into.",
        );
      }
      const ctx = globalArgs.dockerContext
        ? ["--context", globalArgs.dockerContext]
        : [];
      // `-e K=V` rather than a shell prefix: docker exec takes argv directly,
      // so there is no shell to quote for and no way for a value containing
      // spaces (GIT_SSH_COMMAND always does) to be re-split.
      const envArgs = entries.flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return [
        "docker",
        ...ctx,
        "exec",
        ...envArgs,
        globalArgs.container,
        ...cmd,
      ];
    }
    case "ssh": {
      if (!globalArgs.host) {
        throw new Error(
          "probe=ssh requires `host` — the SSH destination to run against.",
        );
      }
      // ssh concatenates its command words and hands the result to a remote
      // shell, so everything here must survive one round of shell parsing.
      const prefix = entries
        .map(([k, v]) => `${k}=${shellQuote(v)} `)
        .join("");
      // BatchMode so an unattended run fails fast instead of blocking on a
      // password prompt that no scheduled job can ever answer.
      return [
        "ssh",
        "-o",
        "BatchMode=yes",
        globalArgs.host,
        prefix + cmd.map(shellQuote).join(" "),
      ];
    }
    default:
      // Local needs no wrapping; env is applied by the runtime instead.
      return cmd;
  }
}

/**
 * Render argv for logs with any `execEnv` value replaced by its key.
 *
 * `execEnv` is where a credential would be passed — a `GIT_SSH_COMMAND` names
 * a key file, and a future caller may well put something more sensitive there.
 * Every place this module renders a command (log line, non-zero exit, timeout)
 * goes through here, because the failure paths are exactly the ones that get
 * pasted into an issue.
 */
export function redactEnvValues(
  argv: string[],
  env?: Record<string, string>,
): string {
  const values = Object.entries(env ?? {})
    // Longest first, so a value that contains another is masked whole.
    .sort((a, b) => b[1].length - a[1].length);

  let line = argv.join(" ");
  for (const [key, value] of values) {
    if (value === "") continue;
    line = line.replaceAll(value, `<${key}>`);
  }
  return line;
}

/**
 * Single-quote a value for a POSIX shell.
 *
 * Only the `ssh` transport needs this — `docker exec` and a local spawn both
 * take argv. Embedded single quotes are closed, escaped and reopened, which is
 * the only form that is safe for arbitrary content.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Run a command against the target and return its stdout.
 *
 * @throws If the command cannot be spawned, times out, or exits non-zero.
 *   Every one of those means the reading did not happen, and a reading that
 *   did not happen must not become a drift verdict.
 */
async function probe(
  globalArgs: GlobalArgs,
  cmd: string[],
  logger: Logger,
  env?: Record<string, string>,
): Promise<string> {
  const argv = transportArgv(globalArgs, cmd, env);
  // Values are deliberately not logged: execEnv is the field a credential
  // would be passed through, and a drift check must not be the thing that
  // prints one into a scheduler's log.
  logger.info("Probing target with {argv}", {
    argv: redactEnvValues(argv, env),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), globalArgs.timeoutMs);

  try {
    const command = new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
      // Only meaningful for the local probe; the other transports carry env
      // inside argv, where it is already applied.
      ...(globalArgs.probe === "local" && env ? { env } : {}),
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    const stdout = decoder.decode(output.stdout);
    const stderr = decoder.decode(output.stderr);

    if (output.code !== 0) {
      throw new Error(
        `${redactEnvValues(argv, env)} exited ${output.code}: ${
          summarise(stderr || stdout)
        }`,
      );
    }
    return stdout;
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(
        `${
          redactEnvValues(argv, env)
        } timed out after ${globalArgs.timeoutMs}ms`,
      );
    }
    if (cause instanceof Deno.errors.NotFound) {
      throw new Error(
        `${
          argv[0]
        } not found on PATH — the ${globalArgs.probe} probe needs it to reach the target.`,
      );
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/** Trim text to something loggable without burying the useful part. */
function summarise(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no output)";
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Read the swamp version the target is running. */
async function readVersion(
  globalArgs: GlobalArgs,
  logger: Logger,
): Promise<ParsedVersion> {
  const out = await probe(globalArgs, [globalArgs.binary, "--version"], logger);
  const parsed = parseSwampVersion(out);
  if (parsed === null) {
    throw new Error(
      `Could not find a swamp version in the output of \`${globalArgs.binary} --version\` ` +
        `on ${describeTarget(globalArgs)}: ${summarise(out)}. ` +
        `Refusing to report a drift status that would be a guess.`,
    );
  }
  return parsed;
}

/** Determine the target's artifact platform, by `uname` unless pinned. */
async function readPlatform(
  globalArgs: GlobalArgs,
  logger: Logger,
): Promise<string> {
  if (globalArgs.platform) return globalArgs.platform;

  // A local probe needs no subprocess: the runtime already knows.
  if (globalArgs.probe === "local") {
    const detected = platformFromUname(
      `${Deno.build.os} ${Deno.build.arch}`,
    );
    if (detected === null) {
      throw new Error(
        `Cannot map this host (${Deno.build.os} ${Deno.build.arch}) to an artifact platform. Set \`platform\` explicitly.`,
      );
    }
    return detected;
  }

  const out = await probe(globalArgs, ["uname", "-s", "-m"], logger);
  const detected = platformFromUname(out);
  if (detected === null) {
    throw new Error(
      `Cannot map \`uname -s -m\` output "${summarise(out, 80)}" from ${
        describeTarget(globalArgs)
      } to an artifact platform. ` +
        `Set \`platform\` explicitly, e.g. platform=linux-x86_64.`,
    );
  }
  return detected;
}

/* ------------------------------------------------------------------ *
 * Resolving the published channel
 * ------------------------------------------------------------------ */

/**
 * Header the channel alias carries its resolved target in.
 *
 * The alias is stored as a website-redirect stub, and the object store
 * surfaces that redirect as metadata rather than following it — so a plain
 * HEAD returns 200 and the real version arrives in this header.
 */
const REDIRECT_HEADER = "x-amz-meta-x-amz-website-redirect-location";

/**
 * Resolve a channel alias to the concrete version published for a platform.
 *
 * One HEAD request, no download. Deliberately platform-specific: the whole
 * point of this model is checking a target that is not the machine running it,
 * and asking the wrong platform's channel is the way to get a confident wrong
 * answer.
 *
 * @throws If the alias does not answer, or answers without a resolvable
 *   version. Both mean the upstream side of the comparison is unknown, and an
 *   unknown upstream must never be reported as "you are current".
 */
export async function resolveChannel(
  globalArgs: GlobalArgs,
  platform: string,
): Promise<ParsedVersion> {
  const url = artifactUrl(
    globalArgs.artifactBaseUrl,
    globalArgs.channel,
    platform,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(globalArgs.timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? `timed out after ${globalArgs.timeoutMs}ms`
      : String(cause);
    throw new Error(`HEAD ${url} failed: ${reason}`);
  }

  if (!res.ok) {
    throw new Error(
      `HEAD ${url} failed: ${res.status} ${res.statusText}. ` +
        `Channel "${globalArgs.channel}" may not publish a ${platform} build.`,
    );
  }

  const location = res.headers.get(REDIRECT_HEADER);
  if (location === null) {
    throw new Error(
      `HEAD ${url} answered ${res.status} but carried no ${REDIRECT_HEADER} header, ` +
        `so the channel could not be resolved to a version. This is how the alias ` +
        `has always published; if it has changed, this model needs updating rather ` +
        `than reporting a version it did not read.`,
    );
  }

  const parsed = parseSwampVersion(location);
  if (parsed === null) {
    throw new Error(
      `Channel "${globalArgs.channel}" for ${platform} redirects to "${
        summarise(location, 120)
      }", which contains no recognisable swamp version.`,
    );
  }
  return parsed;
}

/**
 * Confirm the resolved archive is actually fetchable.
 *
 * This is the precondition for pinning a rebuild to the version: a pin whose
 * archive 404s produces a build that fails partway through, long after the
 * decision to upgrade was made.
 */
async function verifyArtifactUrl(
  url: string,
  timeoutMs: number,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? `timed out after ${timeoutMs}ms`
      : String(cause);
    throw new Error(`Verifying ${url} failed: ${reason}`);
  }
  if (!res.ok) {
    throw new Error(
      `Resolved artifact ${url} is not fetchable: ${res.status} ${res.statusText}. ` +
        `Reporting this version as available would pin a rebuild to a download that fails.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Drift
 * ------------------------------------------------------------------ */

/** Whole hours between two builds, rounded to one decimal, never negative. */
/* ------------------------------------------------------------------ *
 * Repo-content drift
 * ------------------------------------------------------------------ */

/** Resource name for the `repo` spec. Spec-prefixed — see above. */
export function repoResourceName(label: string): string {
  return `repo-${label}`;
}

/**
 * Classify a checkout against the branch it tracks.
 *
 * `diverged` is kept distinct from `behind` rather than folded into it because
 * the two want different responses: behind is fixed by a restart, diverged
 * means a restart *destroys* work, since the entrypoint does `reset --hard`.
 * Both set `behind: true` — both describe undeployed commits on the branch —
 * so a single alert predicate still catches either.
 */
export function classifyRepoDrift(
  commitsBehind: number,
  commitsAhead: number,
): "current" | "behind" | "ahead" | "diverged" {
  if (commitsBehind > 0 && commitsAhead > 0) return "diverged";
  if (commitsBehind > 0) return "behind";
  if (commitsAhead > 0) return "ahead";
  return "current";
}

/**
 * Parse a count printed by `git rev-list --count`.
 *
 * Throws rather than defaulting to 0: a count that could not be read is not a
 * count of zero, and zero is the answer that says "nothing to do".
 */
export function parseCount(raw: string, what: string): number {
  const trimmed = stripAnsi(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Expected a commit count for ${what}, got: ${summarise(raw)}. ` +
        `Refusing to report a drift status that would be a guess.`,
    );
  }
  return parseInt(trimmed, 10);
}

/** Validate and normalise a full commit sha printed by `git rev-parse`. */
export function parseSha(raw: string, what: string): string {
  const trimmed = stripAnsi(raw).trim();
  if (!/^[0-9a-f]{40}$/i.test(trimmed)) {
    throw new Error(
      `Expected a commit sha for ${what}, got: ${summarise(raw)}. ` +
        `Refusing to report a drift status that would be a guess.`,
    );
  }
  return trimmed.toLowerCase();
}

/** Parse a committer date printed by `git log -1 --format=%cI`. */
export function parseCommitDate(raw: string, what: string): Date {
  const trimmed = stripAnsi(raw).trim();
  const parsed = new Date(trimmed);
  if (trimmed === "" || Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Expected an ISO 8601 committer date for ${what}, got: ${
        summarise(raw)
      }. Refusing to report a drift status that would be a guess.`,
    );
  }
  return parsed;
}

export function hoursBetween(older: Date, newer: Date): number {
  const ms = newer.getTime() - older.getTime();
  if (ms <= 0) return 0;
  return Math.round((ms / 3_600_000) * 10) / 10;
}

/**
 * Model type `@sntxrr/swamp-version/target`.
 *
 * @example
 * ```bash
 * # a container on another docker host
 * swamp model create @sntxrr/swamp-version/target swamp-serve \
 *   --global-arg probe=docker \
 *   --global-arg container=swamp-serve \
 *   --global-arg dockerContext=np-docker
 * swamp model @sntxrr/swamp-version/target method run drift swamp-serve
 *
 * # the checkout that container serves, against the branch it tracks
 * swamp model @sntxrr/swamp-version/target method run repoDrift swamp-serve
 *
 * # the binary on this machine
 * swamp model create @sntxrr/swamp-version/target laptop --global-arg probe=local
 * swamp model @sntxrr/swamp-version/target method run drift laptop
 * ```
 */
export const model = {
  type: "@sntxrr/swamp-version/target",
  description:
    "Read the swamp version a host or container runs, and the git checkout it serves, and report how far each has drifted. Read-only — it never updates anything.",
  version: "2026.08.15.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    target: {
      description:
        "What the target reports about itself: the swamp version it runs and the platform it runs on.",
      schema: TargetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    drift: {
      description:
        "Comparison of the target's version against the newest build published for its platform.",
      schema: DriftSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    repo: {
      description:
        "Comparison of the git checkout the target serves against the branch it tracks.",
      schema: RepoDriftSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    sync: {
      description:
        "Record the swamp version and platform the target reports. Read-only.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;
        const label = deriveLabel(globalArgs);
        const target = describeTarget(globalArgs);

        const version = await readVersion(globalArgs, logger);
        const platform = await readPlatform(globalArgs, logger);

        logger.info("{target} runs swamp {version} on {platform}", {
          target,
          version: formatVersion(version),
          platform,
        });

        const handle = await context.writeResource(
          "target",
          targetResourceName(label),
          {
            label,
            probe: globalArgs.probe,
            target,
            version: formatVersion(version),
            builtAt: versionBuiltAt(version).toISOString(),
            platform,
            checkedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    drift: {
      description:
        "Compare the target's swamp version against the newest build published for its platform, and report the resolved artifact a rebuild would pin to. Read-only; updates nothing.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;
        const label = deriveLabel(globalArgs);
        const target = describeTarget(globalArgs);

        const running = await readVersion(globalArgs, logger);
        const platform = await readPlatform(globalArgs, logger);

        logger.info(
          "Resolving channel {channel} for {platform} to compare against {running}",
          {
            channel: globalArgs.channel,
            platform,
            running: formatVersion(running),
          },
        );

        const latest = await resolveChannel(globalArgs, platform);
        const latestVersion = formatVersion(latest);
        const url = artifactUrl(
          globalArgs.artifactBaseUrl,
          latestVersion,
          platform,
        );

        if (globalArgs.verifyArtifact) {
          await verifyArtifactUrl(url, globalArgs.timeoutMs);
        }

        const cmp = compareVersions(running, latest);
        const runningBuiltAt = versionBuiltAt(running);
        const latestBuiltAt = versionBuiltAt(latest);
        const status = cmp === 0 ? "current" : cmp < 0 ? "behind" : "ahead";

        if (status === "behind") {
          logger.warn(
            "{target} is {hours}h behind: running {running}, {channel} is {latest}",
            {
              target,
              hours: hoursBetween(runningBuiltAt, latestBuiltAt),
              running: formatVersion(running),
              channel: globalArgs.channel,
              latest: latestVersion,
            },
          );
        } else if (status === "ahead") {
          // Not an error: a locally built or prerelease binary legitimately
          // outruns the channel, and saying so beats calling it "current".
          logger.info(
            "{target} runs {running}, newer than {channel} ({latest})",
            {
              target,
              running: formatVersion(running),
              channel: globalArgs.channel,
              latest: latestVersion,
            },
          );
        } else {
          logger.info("{target} is up to date on {running}", {
            target,
            running: formatVersion(running),
          });
        }

        const handle = await context.writeResource(
          "drift",
          driftResourceName(label),
          {
            label,
            target,
            platform,
            channel: globalArgs.channel,
            runningVersion: formatVersion(running),
            latestVersion,
            status,
            behind: status === "behind",
            hoursBehind: status === "behind"
              ? hoursBetween(runningBuiltAt, latestBuiltAt)
              : 0,
            runningBuiltAt: runningBuiltAt.toISOString(),
            latestBuiltAt: latestBuiltAt.toISOString(),
            artifactUrl: url,
            artifactVerified: globalArgs.verifyArtifact,
            checkedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    repoDrift: {
      description:
        "Compare the git checkout the target serves against the branch it tracks, and report how many commits it has not deployed. Read-only with respect to the working tree: it fetches and reads refs, and never checks anything out.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;
        const label = deriveLabel(globalArgs);
        const target = describeTarget(globalArgs);
        const { repoDir, repoRef, execEnv } = globalArgs;
        const remoteRef = `origin/${repoRef}`;

        const git = (...args: string[]) =>
          probe(globalArgs, ["git", "-C", repoDir, ...args], logger, execEnv);

        // Fetch first, or the comparison is against whatever the target last
        // saw. That is not a hypothetical: an entrypoint that fetches only at
        // boot leaves `origin/<ref>` frozen at the boot-time tip, so a stale
        // container reports itself current with complete confidence.
        if (globalArgs.repoFetch) {
          await git("fetch", "--quiet", "origin", repoRef);
        } else {
          logger.warn(
            "repoFetch is off — comparing {target} against its last-known {remoteRef}, which may understate the drift",
            { target, remoteRef },
          );
        }

        const deployedSha = parseSha(await git("rev-parse", "HEAD"), "HEAD");
        const remoteSha = parseSha(
          await git("rev-parse", remoteRef),
          remoteRef,
        );

        const commitsBehind = parseCount(
          await git("rev-list", "--count", `HEAD..${remoteRef}`),
          `commits behind ${remoteRef}`,
        );
        const commitsAhead = parseCount(
          await git("rev-list", "--count", `${remoteRef}..HEAD`),
          `commits ahead of ${remoteRef}`,
        );

        const deployedAt = parseCommitDate(
          await git("log", "-1", "--format=%cI", deployedSha),
          "the deployed commit",
        );
        const remoteAt = parseCommitDate(
          await git("log", "-1", "--format=%cI", remoteSha),
          `the tip of ${remoteRef}`,
        );

        const status = classifyRepoDrift(commitsBehind, commitsAhead);

        if (status === "behind") {
          logger.warn(
            "{target} serves {deployed}, {count} commits behind {remoteRef} ({remote})",
            {
              target,
              deployed: deployedSha.slice(0, 7),
              count: commitsBehind,
              remoteRef,
              remote: remoteSha.slice(0, 7),
            },
          );
        } else if (status === "diverged") {
          // Worth its own line: the fix for `behind` actively destroys data here.
          logger.warn(
            "{target} has DIVERGED from {remoteRef}: {behind} behind, {ahead} ahead. A restart does `reset --hard` and will discard the {ahead} local commit(s).",
            {
              target,
              remoteRef,
              behind: commitsBehind,
              ahead: commitsAhead,
            },
          );
        } else if (status === "ahead") {
          logger.warn(
            "{target} is {ahead} commit(s) ahead of {remoteRef} — a deployment checkout should never be ahead, so something was edited in place.",
            { target, ahead: commitsAhead, remoteRef },
          );
        } else {
          logger.info("{target} serves {deployed}, current with {remoteRef}", {
            target,
            deployed: deployedSha.slice(0, 7),
            remoteRef,
          });
        }

        const handle = await context.writeResource(
          "repo",
          repoResourceName(label),
          {
            label,
            target,
            repoDir,
            ref: remoteRef,
            deployedSha,
            deployedShortSha: deployedSha.slice(0, 7),
            remoteSha,
            remoteShortSha: remoteSha.slice(0, 7),
            status,
            behind: commitsBehind > 0,
            commitsBehind,
            commitsAhead,
            hoursBehind: commitsBehind > 0
              ? hoursBetween(deployedAt, remoteAt)
              : 0,
            deployedCommittedAt: deployedAt.toISOString(),
            remoteCommittedAt: remoteAt.toISOString(),
            fetched: globalArgs.repoFetch,
            checkedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
