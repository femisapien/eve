import type { AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { SandboxKey } from "#context/keys.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";

interface BashJob {
  readonly turnId: string;
  readonly pid: number;
  readonly outputDirectory: string;
  readonly identity: string;
}

export const BashJobsKey = new ContextKey<readonly BashJob[]>("eve.bashJobs");

export const BASH_PROCESS_IDENTITY = `identity() {
  if [ -r "/proc/$1/stat" ]; then
    stat=$(cat "/proc/$1/stat") || return 1
    stat=\${stat##*) }
    set -- $stat
    printf '%s:%s\\n' "$(cat /proc/sys/kernel/random/boot_id)" "\${20}"
  else
    ps -o lstart= -p "$1" | sed 's/ *$//'
  fi
}`;

export function registerBashJob(ctx: AlsContext, job: BashJob): void {
  ctx.set(BashJobsKey, [...(ctx.get(BashJobsKey) ?? []), job]);
}

/** A shared sandbox can contain sibling jobs; only the cancelled turn owns these groups. */
export async function cancelBashJobs(ctx: AlsContext, turnId: string): Promise<void> {
  const jobs = ctx.get(BashJobsKey) ?? [];
  const owned = jobs.filter((job) => job.turnId === turnId);
  if (owned.length === 0) return;
  const sandbox = await ctx.require(SandboxKey).get();
  if (sandbox === null) return;
  const commands = owned.map(({ outputDirectory, pid, identity }) => {
    const directory = shellQuote(outputDirectory);
    // Boot and start time also protect jobs after sandbox recreation or PID reuse.
    return `if [ ! -f ${directory}/exit ] && [ "$(cat ${directory}/pid 2>/dev/null)" = ${pid} ] && [ "$(identity ${pid})" = ${shellQuote(identity)} ]; then
  kill -KILL -- -${pid} 2>/dev/null || { kill -0 -- -${pid} 2>/dev/null && exit 1; }
  [ -f ${directory}/exit ] || printf '137\\n' > ${directory}/exit || exit 1
fi`;
  });
  const result = await sandbox.run({ command: `${BASH_PROCESS_IDENTITY}\n${commands.join("\n")}` });
  if (result.exitCode !== 0) throw new Error("Could not stop cancelled bash jobs.");
  ctx.set(
    BashJobsKey,
    jobs.filter((job) => job.turnId !== turnId),
  );
}
