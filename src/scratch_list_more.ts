import { prisma } from "./lib/prisma.js";

async function main() {
  const events = await prisma.webhookEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: 15,
    include: {
      repository: true,
      botActions: true,
    },
  });

  console.log("Recent WebhookEvents:");
  for (const event of events) {
    const payload = event.payload as any;
    console.log(`- ID: ${event.id}`);
    console.log(`  Type: ${event.eventType}`);
    console.log(`  Time: ${event.receivedAt.toLocaleString()}`);
    console.log(`  BotActions count: ${event.botActions.length}`);
    if (event.eventType === "push") {
      const commits = payload?.commits as any[] ?? [];
      console.log(`  Commits count: ${commits.length}`);
      if (commits.length > 0) {
        console.log(`  Commit Msg: "${commits[0].message}"`);
      }
    }
    console.log("-----------------------------------------");
  }
}

main().catch(console.error);
