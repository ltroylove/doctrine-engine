// Fake claude: fails with a nonzero exit code without producing a result message.
process.stdin.resume();
console.error("boom: simulated CLI failure");
process.exit(2);
