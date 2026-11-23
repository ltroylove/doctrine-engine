// Fake claude: spawns a grandchild process and then hangs forever.
// Exercises the process-tree timeout kill: after runAgent times out, BOTH this
// process and the grandchild must be dead (the grandchild pid is emitted so the
// test can probe it).
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
console.log(JSON.stringify({ type: "system", subtype: "spawned", grandchildPid: grandchild.pid }));
process.stdin.resume();
setInterval(() => {}, 1000);
