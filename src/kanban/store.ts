import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardToMarkdown } from "./markdown";
import { CARD_STATUSES, type Board, type CardStatus, type KanbanCard } from "../types";

export type KanbanStoreOptions = {
  rootDir?: string;
};

const emptyBoard = (): Board => ({
  version: 1,
  cards: [],
  updatedAt: new Date(0).toISOString(),
});

const isCardStatus = (value: string): value is CardStatus => CARD_STATUSES.includes(value as CardStatus);

export class LocalKanbanStore {
  private readonly rootDir: string;
  private readonly kanbanDir: string;
  private readonly cardsDir: string;
  private readonly boardPath: string;

  constructor({ rootDir = process.cwd() }: KanbanStoreOptions = {}) {
    this.rootDir = rootDir;
    this.kanbanDir = join(this.rootDir, ".kanban");
    this.cardsDir = join(this.kanbanDir, "cards");
    this.boardPath = join(this.kanbanDir, "board.json");
  }

  async readBoard(): Promise<Board> {
    try {
      return JSON.parse(await readFile(this.boardPath, "utf8")) as Board;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return emptyBoard();
      }
      throw error;
    }
  }

  async addCards(cards: KanbanCard[], now = new Date()): Promise<Board> {
    await mkdir(this.cardsDir, { recursive: true });
    const board = await this.readBoard();
    const existingIds = new Set(board.cards.map((card) => card.id));
    const newCards = cards.filter((card) => !existingIds.has(card.id));
    const next: Board = {
      version: 1,
      cards: [...board.cards, ...newCards],
      updatedAt: now.toISOString(),
    };

    await this.writeBoard(next);
    await Promise.all(newCards.map((card) => this.writeCard(card)));
    return next;
  }

  async moveCard(cardId: string, status: string, now = new Date()): Promise<KanbanCard> {
    if (!isCardStatus(status)) {
      throw new Error(`Invalid status: ${status}. Use one of: ${CARD_STATUSES.join(", ")}`);
    }

    const board = await this.readBoard();
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);

    card.status = status;
    card.updatedAt = now.toISOString();
    board.updatedAt = now.toISOString();
    await this.writeBoard(board);
    await this.writeCard(card);
    return card;
  }

  async nextReadyCard(): Promise<KanbanCard | undefined> {
    const board = await this.readBoard();
    return board.cards.find((card) => card.status === "ready");
  }

  private async writeBoard(board: Board): Promise<void> {
    await mkdir(this.kanbanDir, { recursive: true });
    await writeFile(this.boardPath, `${JSON.stringify(board, null, 2)}\n`);
  }

  private async writeCard(card: KanbanCard): Promise<void> {
    await writeFile(join(this.cardsDir, `${card.id}.md`), cardToMarkdown(card));
  }
}
