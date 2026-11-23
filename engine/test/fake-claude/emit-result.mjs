// Fake claude: reads the full prompt from stdin, emits noise + a valid final result
// whose `result` field reports what it observed (prompt length, whether the API key
// leaked into its environment). Lets one fixture verify stdin delivery + env hardening.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log("this line is not json at all");
  console.log('{"type":"assistant","truncated'); // deliberately partial JSON
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.42,
      result: JSON.stringify({
        promptLen: input.length,
        hasApiKey: Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
        backgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null,
      }),
    }),
  );
  process.exit(0);
});
