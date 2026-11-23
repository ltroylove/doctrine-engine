// Fake claude: run was cut off by the budget cap. Exit code is 0 — truncation must be
// detected from the result subtype, never inferred from exit status.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      total_cost_usd: 5.0,
      result: "ran out of budget mid-flight",
    }),
  );
  process.exit(0);
});
