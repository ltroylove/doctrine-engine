// Fake claude: the API was overloaded — the CLI retried, gave up, and exited nonzero
// having spent nothing. Mirrors the real 529 log shape observed in Phase A calibration.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 529,
      total_cost_usd: 0,
      result: "API Error: 529 Overloaded.",
    }),
  );
  process.exit(1);
});
