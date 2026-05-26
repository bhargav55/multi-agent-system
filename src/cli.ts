#!/usr/bin/env bun
import { planBriefToKanban } from "./orchestrator";
import { LocalKanbanStore } from "./kanban/store";

const usage = () => {
  console.log(`Usage:
  multi-agent plan <brief.md>
  multi-agent board
  multi-agent next
  multi-agent move <card-id> <status>`);
};

const printBoard = async () => {
  const board = await new LocalKanbanStore().readBoard();
  if (board.cards.length === 0) {
    console.log("No cards found.");
    return;
  }

  for (const card of board.cards) {
    console.log(`${card.id}\t${card.status}\t${card.priority}\t${card.title}`);
  }
};

const main = async () => {
  const [command, ...args] = Bun.argv.slice(2);

  if (command === "plan") {
    const [briefPath] = args;
    if (!briefPath) {
      usage();
      process.exit(1);
    }

    const board = await planBriefToKanban({ briefPath });
    console.log(JSON.stringify({ ok: true, cards: board.cards.length, board: ".kanban/board.json" }, null, 2));
    return;
  }

  if (command === "board") {
    await printBoard();
    return;
  }

  if (command === "next") {
    const card = await new LocalKanbanStore().nextReadyCard();
    if (!card) {
      console.log("No ready cards.");
      return;
    }
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  if (command === "move") {
    const [cardId, status] = args;
    if (!cardId || !status) {
      usage();
      process.exit(1);
    }

    const card = await new LocalKanbanStore().moveCard(cardId, status);
    console.log(JSON.stringify({ ok: true, id: card.id, status: card.status }, null, 2));
    return;
  }

  usage();
  process.exit(command ? 1 : 0);
};

await main();
