/**
 * NW-020 — scenario player CLI.
 *
 *   # deterministic: prints every event, scenario-relative, no Kafka
 *   node dist/src/index.js scenarios/oslofjord.json --dry-run
 *
 *   # live playback at 10x onto the isolated `sim` namespace
 *   KAFKA_BROKERS=localhost:19092 node dist/src/index.js scenarios/oslofjord.json --speed 10
 *
 *   # drive a fusion-svc that is listening on `perf.*`
 *   node dist/src/index.js scenarios/oslofjord.json --env perf --speed 1 --loop
 */
import { readFileSync } from "node:fs";
import { ZodError } from "zod";
import { tick } from "./engine.js";
import { toEvent } from "./emit.js";
import { play } from "./player.js";
import { parseScenario } from "./scenario.js";
import { analyseScenario, formatAnalysis } from "./validate.js";

export * from "./engine.js";
export * from "./emit.js";
export * from "./geo.js";
export * from "./player.js";
export * from "./rng.js";
export * from "./scenario.js";
export * from "./validate.js";

interface Args {
  file: string;
  dryRun: boolean;
  validate: boolean;
  speed: number;
  loop: boolean;
  env: string;
  tickMs: number;
}

function parseArgs(argv: string[]): Args {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: scenario <file.json> [--validate] [--dry-run] [--speed N] [--loop] [--env sim] [--tick-ms N]");
    process.exit(64);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    file,
    dryRun: argv.includes("--dry-run"),
    validate: argv.includes("--validate"),
    speed: Number(flag("speed") ?? 1),
    loop: argv.includes("--loop"),
    // Default `sim`, never `dev`: see README. @vektor/latency-harness
    // deliberately does the opposite because it must reach a live service.
    env: flag("env") ?? process.env.VEKTOR_ENV ?? "sim",
    tickMs: Number(flag("tick-ms") ?? 250),
  };
}

/**
 * A scenario is hand-edited, so the common failure is a typo and the raw
 * ZodError dump is the wrong thing to show for it — it is a JSON blob of
 * issue objects that buries the one line the author needs. Print the path
 * and message, exit 65 (EX_DATAERR) so a script can tell a bad file from a
 * playback failure.
 */
function loadScenario(file: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(65);
  }
  try {
    return parseScenario(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      console.error(`${file} is not a valid scenario:\n`);
      for (const issue of err.issues) {
        console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      process.exit(65);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenario = loadScenario(args.file);

  if (args.validate) {
    const reports = analyseScenario(scenario);
    console.log(formatAnalysis(reports));
    const bad = reports.filter((r) => r.implausible).length;
    console.log(bad === 0 ? "\nall legs plausible" : `\n${bad} implausible leg(s) — see above`);
    return;
  }

  if (args.dryRun) {
    // The determinism check. event_id is replaced with a counter and
    // sensor_ts with the scenario-relative time, so the output is a
    // function of (scenario, seed) alone and can be diffed against a
    // golden file. Live playback cannot do this — fusion-svc's watermark
    // needs real timestamps — which is exactly why the two paths differ.
    const states = tick(scenario, 0, scenario.duration_s + 1);
    const byEntity = new Map(scenario.entities.map((e) => [e.id, e]));
    let n = 0;
    const epoch = new Date("2000-01-01T00:00:00.000Z").getTime();
    for (const state of states) {
      const entity = byEntity.get(state.entityId)!;
      const event = toEvent(entity, state, {
        sensorId: scenario.sensor_id,
        sensorTs: new Date(epoch + state.t * 1000),
        nextEventId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
      });
      console.log(JSON.stringify({ t: state.t, topic: `${event.domain}.${event.action}`, value: event.value }));
    }
    console.error(`\n${states.length} events, ${scenario.entities.length} entities, seed ${scenario.seed}`);
    return;
  }

  const brokers = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => controller.abort());
  }

  console.error(
    `playing "${scenario.name}" -> ${args.env}.vektor.* at ${args.speed}x ` +
      `(${scenario.entities.length} entities, ${scenario.duration_s}s${args.loop ? ", looping" : ""})`,
  );

  let lastReport = Date.now();
  const result = await play({
    scenario,
    brokers,
    env: args.env,
    speed: args.speed,
    loop: args.loop,
    tickMs: args.tickMs,
    signal: controller.signal,
    onBatch: (events, scenarioT) => {
      if (Date.now() - lastReport > 2000) {
        console.error(`  t=${scenarioT.toFixed(0)}s  +${events.length} events`);
        lastReport = Date.now();
      }
    },
  });

  console.error(
    `\npublished ${result.published} events over ${(result.wallMs / 1000).toFixed(1)}s wall` +
      ` (${(result.published / (result.wallMs / 1000)).toFixed(1)}/sec, ${result.loops} loop(s))`,
  );
}

// Only run the CLI when executed directly — this module is also the
// package's library entry point, and importing it must not start playback.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
