import { runSetup } from "./setup";
import { runScraper } from "./scraper";

const args = process.argv.slice(2);
const isSetup = args.includes("--setup");

async function main() {
  if (isSetup) {
    await runSetup();
  } else {
    await runScraper();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
