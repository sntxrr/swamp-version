/**
 * Tests for `@sntxrr/swamp-version/target`.
 *
 * Two things here are load-bearing rather than decorative:
 *
 * 1. **The `writeResource` stub validates against the model's real schemas.**
 *    A stub that merely records what it was handed makes every schema bug
 *    invisible — the tests pass, and the failure surfaces at run time as a
 *    validation error in production instead. `validatingContext` runs the
 *    actual `model.resources.<spec>.schema` over the payload, so a field the
 *    schema does not allow fails here.
 *
 * 2. **The ordering tests cover the unpadded build ordinal specifically.**
 *    That is the one component of a swamp version where string comparison
 *    silently produces the wrong answer, and the wrong answer is "you are up
 *    to date".
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  artifactUrl,
  compareVersions,
  deriveLabel,
  describeTarget,
  driftResourceName,
  formatVersion,
  hoursBetween,
  model,
  parseSwampVersion,
  platformFromUname,
  platformPath,
  slug,
  stripAnsi,
  targetResourceName,
  transportArgv,
  versionBuiltAt,
} from "./swamp_target.ts";

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

// deno-lint-ignore no-explicit-any
type AnyArgs = any;

/** Global args with every default filled in, overridable per test. */
function args(overrides: Record<string, unknown> = {}): AnyArgs {
  return {
    probe: "local",
    binary: "swamp",
    channel: "stable",
    artifactBaseUrl: "https://artifacts.swamp-club.com",
    verifyArtifact: true,
    timeoutMs: 15000,
    ...overrides,
  };
}

const silentLogger = { info: () => {}, warn: () => {} };

/**
 * A context whose writeResource validates against the model's real schema.
 *
 * See the file header: this is the difference between a test suite that proves
 * the payload is correct and one that proves only that a payload was produced.
 */
function validatingContext(globalArgs: AnyArgs) {
  const written: Array<{ spec: string; name: string; data: AnyArgs }> = [];
  return {
    written,
    context: {
      globalArgs,
      logger: silentLogger,
      writeResource: (spec: string, name: string, data: AnyArgs) => {
        const schema =
          (model.resources as Record<string, { schema: AnyArgs }>)[spec];
        if (!schema) throw new Error(`no such spec: ${spec}`);
        schema.schema.parse(data); // throws on any schema violation
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    } as AnyArgs,
  };
}

/** Swap in a fake `Deno.Command` for the duration of `fn`. */
async function withFakeCommand(
  handler: (argv: string[]) => { code?: number; stdout?: string },
  fn: () => Promise<void>,
) {
  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class {
    #argv: string[];
    constructor(cmd: string, opts: { args?: string[] }) {
      this.#argv = [cmd, ...(opts.args ?? [])];
    }
    output() {
      const r = handler(this.#argv);
      const enc = new TextEncoder();
      return Promise.resolve({
        code: r.code ?? 0,
        stdout: enc.encode(r.stdout ?? ""),
        stderr: enc.encode(""),
      });
    }
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}

/** Swap in a fake `fetch` for the duration of `fn`. */
async function withFakeFetch(
  handler: (url: string) => Response,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: AnyArgs) =>
    Promise.resolve(handler(String(input)))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const REDIRECT_HEADER = "x-amz-meta-x-amz-website-redirect-location";

/** A stable-alias HEAD response resolving to `version`. */
function channelResponse(version: string, platform = "linux-x86_64"): Response {
  return new Response(null, {
    status: 200,
    headers: {
      [REDIRECT_HEADER]: artifactUrl(
        "https://artifacts.swamp-club.com",
        version,
        platform,
      ),
    },
  });
}

/* ------------------------------------------------------------------ *
 * Version parsing
 * ------------------------------------------------------------------ */

Deno.test("parseSwampVersion reads a full version with its commit", () => {
  const v = parseSwampVersion("20260808.001107.0-sha.71792d3a");
  assertEquals(v, { date: 20260808, time: 1107, build: 0, sha: "71792d3a" });
});

Deno.test("parseSwampVersion reads a version with no commit suffix", () => {
  const v = parseSwampVersion("20260730.013940.2");
  assertEquals(v, { date: 20260730, time: 13940, build: 2, sha: null });
});

Deno.test("parseSwampVersion finds the version inside real CLI output", () => {
  // What `swamp --version` actually prints, escape codes and all.
  const raw = "\x1b[1mswamp\x1b[22m \x1b[94m20260807.031228.0-sha.9a36314e\x1b[39m\n";
  const v = parseSwampVersion(raw);
  assertEquals(formatVersion(v!), "20260807.031228.0-sha.9a36314e");
});

Deno.test("parseSwampVersion returns null when there is no version", () => {
  assertEquals(parseSwampVersion("command not found: swamp"), null);
  assertEquals(parseSwampVersion(""), null);
  // Close, but not the shape: too few digits in the date.
  assertEquals(parseSwampVersion("2026080.001107.0"), null);
});

Deno.test("stripAnsi removes colour without touching the text", () => {
  assertEquals(stripAnsi("\x1b[94mhello\x1b[39m"), "hello");
  assertEquals(stripAnsi("plain"), "plain");
});

Deno.test("formatVersion round-trips what parseSwampVersion read", () => {
  for (
    const s of [
      "20260808.001107.0-sha.71792d3a",
      "20260730.013940.2",
      "20260101.000000.11",
    ]
  ) {
    assertEquals(formatVersion(parseSwampVersion(s)!), s);
  }
});

/* ------------------------------------------------------------------ *
 * Ordering — the reason this model parses instead of string-comparing
 * ------------------------------------------------------------------ */

Deno.test("compareVersions orders by date, then time, then ordinal", () => {
  const a = parseSwampVersion("20260730.013940.0")!;
  const b = parseSwampVersion("20260807.031228.0")!;
  const c = parseSwampVersion("20260807.203020.0")!;

  assert(compareVersions(a, b) < 0, "older date sorts first");
  assert(compareVersions(b, c) < 0, "same date, earlier time sorts first");
  assert(compareVersions(c, a) > 0);
  assertEquals(compareVersions(b, b), 0);
});

Deno.test("compareVersions survives the unpadded build ordinal", () => {
  // The trap: as strings, "…0" < "…10" < "…9", so a string compare reports the
  // 10th build of the day as OLDER than the 9th — and a target on build 9
  // as up to date when build 10 is out.
  const ninth = parseSwampVersion("20260808.001107.9")!;
  const tenth = parseSwampVersion("20260808.001107.10")!;

  assert("20260808.001107.10" < "20260808.001107.9", "string order is wrong");
  assert(compareVersions(ninth, tenth) < 0, "numeric order is right");
});

Deno.test("compareVersions ignores the commit sha", () => {
  const a = parseSwampVersion("20260808.001107.0-sha.aaaaaaaa")!;
  const b = parseSwampVersion("20260808.001107.0-sha.ffffffff")!;
  assertEquals(compareVersions(a, b), 0);
});

Deno.test("versionBuiltAt reads the embedded timestamp as UTC", () => {
  const v = parseSwampVersion("20260808.001107.0-sha.71792d3a")!;
  assertEquals(versionBuiltAt(v).toISOString(), "2026-08-08T00:11:07.000Z");
});

Deno.test("hoursBetween measures lag and never goes negative", () => {
  const older = versionBuiltAt(parseSwampVersion("20260807.031228.0")!);
  const newer = versionBuiltAt(parseSwampVersion("20260808.001107.0")!);

  assertEquals(hoursBetween(older, newer), 21);
  assertEquals(hoursBetween(newer, older), 0, "reversed order clamps to zero");
  assertEquals(hoursBetween(newer, newer), 0);
});

/* ------------------------------------------------------------------ *
 * Platform handling
 * ------------------------------------------------------------------ */

Deno.test("platformFromUname normalises every spelling of arm64", () => {
  assertEquals(platformFromUname("Linux x86_64"), "linux-x86_64");
  assertEquals(platformFromUname("Linux aarch64"), "linux-aarch64");
  assertEquals(platformFromUname("Darwin arm64"), "darwin-aarch64");
  assertEquals(platformFromUname("linux amd64"), "linux-x86_64");
  assertEquals(platformFromUname("Darwin x86_64\n"), "darwin-x86_64");
});

Deno.test("platformFromUname returns null rather than guessing", () => {
  assertEquals(platformFromUname("FreeBSD amd64"), null);
  assertEquals(platformFromUname("Linux riscv64"), null);
  assertEquals(platformFromUname("Linux"), null);
  assertEquals(platformFromUname(""), null);
});

Deno.test("platformPath rejects a malformed platform slug", () => {
  assertEquals(platformPath("linux-x86_64"), { os: "linux", arch: "x86_64" });
  assertThrows(() => platformPath("linux"), Error, "not in <os>-<arch> form");
});

Deno.test("artifactUrl matches the official install.sh construction", () => {
  // Verified against a real 200 from the artifact host — the channel alias is
  // substituted into both the path and the filename.
  assertEquals(
    artifactUrl("https://artifacts.swamp-club.com", "stable", "linux-x86_64"),
    "https://artifacts.swamp-club.com/swamp/stable/binary/linux/x86_64/swamp-stable-binary-linux-x86_64.tar.gz",
  );
  assertEquals(
    artifactUrl(
      "https://artifacts.swamp-club.com/",
      "20260808.001107.0-sha.71792d3a",
      "darwin-aarch64",
    ),
    "https://artifacts.swamp-club.com/swamp/20260808.001107.0-sha.71792d3a/binary/darwin/aarch64/swamp-20260808.001107.0-sha.71792d3a-binary-darwin-aarch64.tar.gz",
  );
});

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

Deno.test("the two specs can never write the same resource name", () => {
  for (
    const label of [
      "local",
      "np-docker-swamp-serve",
      "target-drift",
      "drift-target",
      "",
    ]
  ) {
    assert(
      targetResourceName(label) !== driftResourceName(label),
      `collision for label "${label}"`,
    );
  }
});

Deno.test("deriveLabel keeps the same container on two contexts distinct", () => {
  const a = deriveLabel(
    args({ probe: "docker", container: "swamp-serve", dockerContext: "np-docker" }),
  );
  const b = deriveLabel(
    args({ probe: "docker", container: "swamp-serve", dockerContext: "other" }),
  );
  assert(a !== b, "context must participate in the label");
  assertEquals(a, "np-docker-swamp-serve");
});

Deno.test("deriveLabel prefers an explicit label and sanitises it", () => {
  assertEquals(deriveLabel(args({ label: "prod serve!" })), "prod-serve");
  assertEquals(deriveLabel(args({ probe: "ssh", host: "user@docker" })), "user-docker");
  assertEquals(deriveLabel(args({ probe: "local" })), "local");
});

Deno.test("slug never returns an empty name", () => {
  assertEquals(slug("!!!"), "target");
  assertEquals(slug("a  b"), "a-b");
});

Deno.test("describeTarget names what was probed", () => {
  assertEquals(
    describeTarget(
      args({ probe: "docker", container: "swamp-serve", dockerContext: "np-docker" }),
    ),
    "docker://np-docker/swamp-serve",
  );
  assertEquals(describeTarget(args({ probe: "ssh", host: "docker" })), "ssh://docker");
  assertEquals(describeTarget(args({ probe: "local" })), "local");
});

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

Deno.test("transportArgv builds the right command per probe", () => {
  assertEquals(transportArgv(args({ probe: "local" }), ["swamp", "--version"]), [
    "swamp",
    "--version",
  ]);

  assertEquals(
    transportArgv(
      args({ probe: "docker", container: "swamp-serve", dockerContext: "np-docker" }),
      ["swamp", "--version"],
    ),
    ["docker", "--context", "np-docker", "exec", "swamp-serve", "swamp", "--version"],
  );

  assertEquals(
    transportArgv(args({ probe: "docker", container: "swamp-serve" }), ["uname", "-s"]),
    ["docker", "exec", "swamp-serve", "uname", "-s"],
  );

  assertEquals(
    transportArgv(args({ probe: "ssh", host: "docker" }), ["swamp", "--version"]),
    ["ssh", "-o", "BatchMode=yes", "docker", "swamp --version"],
  );
});

Deno.test("transportArgv refuses an incomplete probe", () => {
  assertThrows(
    () => transportArgv(args({ probe: "docker" }), ["swamp"]),
    Error,
    "requires `container`",
  );
  assertThrows(
    () => transportArgv(args({ probe: "ssh" }), ["swamp"]),
    Error,
    "requires `host`",
  );
});

/* ------------------------------------------------------------------ *
 * sync
 * ------------------------------------------------------------------ */

Deno.test("sync records the version and platform, schema-valid", async () => {
  const globalArgs = args({
    probe: "docker",
    container: "swamp-serve",
    dockerContext: "np-docker",
  });
  const { written, context } = validatingContext(globalArgs);

  await withFakeCommand(
    (argv) =>
      argv.includes("uname")
        ? { stdout: "Linux x86_64\n" }
        : { stdout: "swamp 20260730.013940.0-sha.7e40de69\n" },
    async () => {
      await model.methods.sync.execute({}, context);
    },
  );

  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "target");
  assertEquals(written[0].name, "target-np-docker-swamp-serve");
  assertEquals(written[0].data.version, "20260730.013940.0-sha.7e40de69");
  assertEquals(written[0].data.platform, "linux-x86_64");
  assertEquals(written[0].data.builtAt, "2026-07-30T01:39:40.000Z");
  assertEquals(written[0].data.target, "docker://np-docker/swamp-serve");
});

Deno.test("sync throws when the target has no parseable version", async () => {
  const { context } = validatingContext(args({ probe: "local" }));
  let threw: Error | null = null;

  await withFakeCommand(() => ({ stdout: "swamp: command not found\n" }), async () => {
    try {
      await model.methods.sync.execute({}, context);
    } catch (e) {
      threw = e as Error;
    }
  });

  assert(threw !== null, "must not silently record a missing version");
  assert(
    (threw as Error).message.includes("would be a guess"),
    `unexpected message: ${(threw as Error).message}`,
  );
});

/* ------------------------------------------------------------------ *
 * drift
 * ------------------------------------------------------------------ */

Deno.test("drift reports a behind target with its lag and artifact", async () => {
  const globalArgs = args({
    probe: "docker",
    container: "swamp-serve",
    dockerContext: "np-docker",
  });
  const { written, context } = validatingContext(globalArgs);

  await withFakeCommand(
    (argv) =>
      argv.includes("uname")
        ? { stdout: "Linux x86_64\n" }
        : { stdout: "swamp 20260730.013940.0-sha.7e40de69\n" },
    async () => {
      await withFakeFetch(
        (url) =>
          url.includes("/stable/")
            ? channelResponse("20260808.001107.0-sha.71792d3a")
            : new Response(null, { status: 200 }),
        async () => {
          await model.methods.drift.execute({}, context);
        },
      );
    },
  );

  const d = written[0].data;
  assertEquals(written[0].spec, "drift");
  assertEquals(written[0].name, "drift-np-docker-swamp-serve");
  assertEquals(d.status, "behind");
  assertEquals(d.behind, true);
  assertEquals(d.runningVersion, "20260730.013940.0-sha.7e40de69");
  assertEquals(d.latestVersion, "20260808.001107.0-sha.71792d3a");
  assertEquals(d.platform, "linux-x86_64");
  assertEquals(d.artifactVerified, true);
  assertEquals(
    d.artifactUrl,
    "https://artifacts.swamp-club.com/swamp/20260808.001107.0-sha.71792d3a/binary/linux/x86_64/swamp-20260808.001107.0-sha.71792d3a-binary-linux-x86_64.tar.gz",
  );
  assert(d.hoursBehind > 200, `expected a large lag, got ${d.hoursBehind}`);
});

Deno.test("drift reports current when the target is on the channel build", async () => {
  const { written, context } = validatingContext(args({ probe: "local", platform: "linux-x86_64" }));

  await withFakeCommand(() => ({ stdout: "swamp 20260808.001107.0-sha.71792d3a\n" }), async () => {
    await withFakeFetch(
      (url) =>
        url.includes("/stable/")
          ? channelResponse("20260808.001107.0-sha.71792d3a")
          : new Response(null, { status: 200 }),
      async () => {
        await model.methods.drift.execute({}, context);
      },
    );
  });

  assertEquals(written[0].data.status, "current");
  assertEquals(written[0].data.behind, false);
  assertEquals(written[0].data.hoursBehind, 0);
});

Deno.test("drift reports ahead rather than current for a newer local build", async () => {
  const { written, context } = validatingContext(args({ probe: "local", platform: "linux-x86_64" }));

  await withFakeCommand(() => ({ stdout: "swamp 20260809.120000.0\n" }), async () => {
    await withFakeFetch(
      (url) =>
        url.includes("/stable/")
          ? channelResponse("20260808.001107.0-sha.71792d3a")
          : new Response(null, { status: 200 }),
      async () => {
        await model.methods.drift.execute({}, context);
      },
    );
  });

  assertEquals(written[0].data.status, "ahead");
  assertEquals(written[0].data.behind, false);
  assertEquals(written[0].data.hoursBehind, 0);
});

Deno.test("drift throws when the channel answers without a redirect header", async () => {
  const { context } = validatingContext(args({ probe: "local", platform: "linux-x86_64" }));
  let threw: Error | null = null;

  await withFakeCommand(() => ({ stdout: "swamp 20260730.013940.0\n" }), async () => {
    await withFakeFetch(() => new Response(null, { status: 200 }), async () => {
      try {
        await model.methods.drift.execute({}, context);
      } catch (e) {
        threw = e as Error;
      }
    });
  });

  assert(threw !== null, "an unresolvable channel must not report 'current'");
  assert((threw as Error).message.includes("could not be resolved"));
});

Deno.test("drift throws when the resolved artifact is not fetchable", async () => {
  const { context } = validatingContext(args({ probe: "local", platform: "linux-x86_64" }));
  let threw: Error | null = null;

  await withFakeCommand(() => ({ stdout: "swamp 20260730.013940.0\n" }), async () => {
    await withFakeFetch(
      (url) =>
        url.includes("/stable/")
          ? channelResponse("20260808.001107.0-sha.71792d3a")
          : new Response(null, { status: 404, statusText: "Not Found" }),
      async () => {
        try {
          await model.methods.drift.execute({}, context);
        } catch (e) {
          threw = e as Error;
        }
      },
    );
  });

  assert(threw !== null, "an unbuildable version must not be offered as a pin");
  assert((threw as Error).message.includes("not fetchable"));
});

Deno.test("drift propagates a failed probe instead of reporting a verdict", async () => {
  const { context } = validatingContext(args({ probe: "local" }));
  let threw: Error | null = null;

  await withFakeCommand(() => ({ code: 127, stdout: "" }), async () => {
    try {
      await model.methods.drift.execute({}, context);
    } catch (e) {
      threw = e as Error;
    }
  });

  assert(threw !== null, "an unreachable target must not produce a drift status");
  assert((threw as Error).message.includes("exited 127"));
});
