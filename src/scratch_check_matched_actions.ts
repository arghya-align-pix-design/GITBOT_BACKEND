import { prisma } from "./lib/prisma.js";

async function main() {
  const actions = await prisma.botAction.findMany({
    where: {
      webhookEventId: {
        in: [
          "cmr4ml1f4000dw5aslqvk9wmh",
          "cmr4mijp80009w5asgnzc5dh3",
          "cmr4mgs5o0001w5asqq4gej3v"
        ]
      }
    }
  });

  console.log("BotActions for matched events:");
  for (const act of actions) {
    console.log(`- Event ID: ${act.webhookEventId}`);
    console.log(`  Action Type: ${act.actionType}`);
    console.log(`  Status: ${act.status}`);
    console.log(`  Detail: ${act.detail}`);
    console.log("-----------------------------------------");
  }
}

main().catch(console.error);
