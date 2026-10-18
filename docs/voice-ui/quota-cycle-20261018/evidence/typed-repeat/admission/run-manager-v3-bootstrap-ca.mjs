// Cumulative cap raised by explicit User authority; prior journal and per-process 300 cap remain.
// Run-local evidence tool, kept in the task worktree. No credential or provider payload is read here.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const root = "/work/repos/voice-ui-typellm-20261016";
const [action, configFile] = process.argv.slice(2);
if (!["start", "stop", "status"].includes(action) || !configFile?.startsWith(root + "/")) throw Error("manager_arguments");
const config = JSON.parse(fs.readFileSync(configFile)), phase = config.phase_id;
if (!/^[A-Za-z0-9_-]{1,64}$/.test(phase ?? "") || !["jev", "typellm"].every(p => Number.isInteger(config.allowances?.[p])
    && config.allowances[p] >= 0 && config.allowances[p] <= 300)) throw Error("manager_config");
const lock = root + "/budget.lock", lockFd = fs.openSync(lock, "wx", 0o600);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (file, value) => {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(root, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
};
const append = value => {
  const fd = fs.openSync(root + "/provider-events.jsonl", "a");
  try { fs.writeSync(fd, JSON.stringify({ ...value, at: new Date().toISOString() }) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
const stat = pid => {
  try {
    const value = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid, state: fields[0], pgid: Number(fields[2]), start_ticks: fields[19] };
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
};
const group = pgid => fs.readdirSync("/proc").filter(name => /^[0-9]+$/.test(name)).map(Number).map(stat)
  .filter(item => item?.pgid === pgid);
try {
  const events = fs.readFileSync(root + "/provider-events.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
  const charged = { jev: 0, typellm: 0 }, outstanding = new Map();
  for (const item of events) {
    if (item.kind === "reserve") {
      if (!["jev", "typellm"].includes(item.provider) || item.charge !== 1) throw Error("unknown_prior_charge");
      charged[item.provider]++;
    } else if (item.kind === "phase-reserve") {
      if (outstanding.has(item.id)) throw Error("duplicate_phase");
      outstanding.set(item.id, item.allowances);
    } else if (item.kind === "phase-reconcile") {
      const reserved = outstanding.get(item.id);
      if (!reserved) throw Error("unreserved_reconciliation");
      for (const p of ["jev", "typellm"]) {
        if (!Number.isInteger(item.sent[p]) || item.sent[p] < 0 || item.sent[p] > reserved[p]) throw Error("invalid_reconciliation");
        charged[p] += item.sent[p];
      }
      outstanding.delete(item.id);
    } else if (item.kind !== "outcome") throw Error("unknown_ledger_event");
  }
  const receiptFile = root + "/" + phase + ".process.json";
  if (action === "start") {
    if (outstanding.size || events.some(item => item.id === phase)) throw Error("outstanding_or_reused_phase");
    if (!["jev", "typellm"].every(p => charged[p] + config.allowances[p] <= 1000)) throw Error("whole_run_cap");
    if (!/^\/nix\/store\/[a-z0-9]{32}-[^\s]+\/bin\/voice-ui-typed-dev$/.test(config.program ?? "")
        || !["apps", "envs"].every(p => /^[a-f0-9]{40}$/.test(config.heads?.[p] ?? ""))) throw Error("launch_identity");
    const stdout = root + "/" + phase + ".stdout.log", stderr = root + "/" + phase + ".stderr.log";
    const out = fs.openSync(stdout, "wx", 0o600), err = fs.openSync(stderr, "wx", 0o600);
    append({ kind: "phase-reserve", id: phase, allowances: config.allowances, prior_charged: charged,
      config_sha256: hash(fs.readFileSync(configFile)), program: config.program, heads: config.heads });
    let child;
    try {
      child = spawn(config.program, ["--envs-sha", config.heads.envs, "--apps-sha", config.heads.apps, "--port", "18845",
        "--jev-limit", String(config.allowances.jev), "--typellm-limit", String(config.allowances.typellm)], {
        cwd: "/work/repos", env: { PATH: "/bin", HOME: process.env.HOME, LANG: "C.UTF-8",
          GIT_SSL_CAINFO: "/nix/store/8pzhla2fz926ir6kjlgqnfrz34bjsjl0-nss-cacert-3.125/etc/ssl/certs/ca-bundle.crt", SSL_CERT_FILE: "/nix/store/8pzhla2fz926ir6kjlgqnfrz34bjsjl0-nss-cacert-3.125/etc/ssl/certs/ca-bundle.crt" },
        detached: true, stdio: ["ignore", out, err],
      });
      child.on("error", () => { process.exitCode = 1; });
      const observed = stat(child.pid);
      if (!observed || observed.pgid !== child.pid) throw Error("launch_identity_unknown");
      write(receiptFile, { phase_id: phase, ...observed, program: config.program, heads: config.heads,
        allowances: config.allowances, stdout, stderr, config_sha256: hash(fs.readFileSync(configFile)) });
      child.unref(); console.log(JSON.stringify({ phase, ...observed, reserved: config.allowances, prior_charged: charged }));
    } finally { fs.closeSync(out); fs.closeSync(err); }
  } else {
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    if (receipt.phase_id !== phase || !outstanding.has(phase)) throw Error("phase_not_outstanding");
    let current = stat(receipt.pid);
    if (current && current.start_ticks !== receipt.start_ticks) throw Error("pid_reused");
    if (action === "stop") {
      if (current && current.state !== "Z") {
        if (current.pgid !== receipt.pid) throw Error("process_group_mismatch");
        process.kill(-receipt.pid, "SIGTERM");
      }
      for (let n = 0; n < 100 && group(receipt.pid).length; n++) await new Promise(resolve => setTimeout(resolve, 100));
      if (group(receipt.pid).length) throw Error("stop_not_confirmed");
      for (const file of [receipt.stdout, receipt.stderr]) { const fd = fs.openSync(file, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    }
    const bytes = fs.readFileSync(receipt.stderr), sent = { jev: 0, typellm: 0 };
    for (const line of bytes.toString("utf8").split("\n")) {
      const match = /^provider-send:(jev|typellm):([1-9][0-9]*)$/.exec(line);
      if (match) {
        if (Number(match[2]) !== sent[match[1]] + 1) throw Error("send_sequence_unknown");
        sent[match[1]]++;
      } else if (line.startsWith("provider-send:")) throw Error("send_log_unknown");
    }
    if (!["jev", "typellm"].every(p => sent[p] <= receipt.allowances[p])) throw Error("allowance_exceeded");
    if (action === "stop") append({ kind: "phase-reconcile", id: phase, sent, stopped_group_empty: true,
      pid: receipt.pid, start_ticks: receipt.start_ticks, stderr_sha256: hash(bytes), stdout_sha256: hash(fs.readFileSync(receipt.stdout)) });
    console.log(JSON.stringify({ phase, action, current, sent, whole_run_sent: { jev: charged.jev + sent.jev, typellm: charged.typellm + sent.typellm },
      reserved_until_confirmed_stop: action === "status" ? receipt.allowances : null }));
  }
} finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
