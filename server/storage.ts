import { eq, desc } from "drizzle-orm";
import { db } from "./db";
import {
  hubspotChangeLog,
  type HubspotChangeLog,
  type InsertHubspotChangeLog,
} from "@shared/schema";

export interface IStorage {
  createHubspotChangeLog(entry: InsertHubspotChangeLog): Promise<HubspotChangeLog>;
  listHubspotChangeLog(limit?: number): Promise<HubspotChangeLog[]>;
  getHubspotChangeLog(id: number): Promise<HubspotChangeLog | undefined>;
  updateHubspotChangeLogUndo(
    id: number,
    status: "undone" | "undo_failed",
    undoResult: unknown,
  ): Promise<HubspotChangeLog>;
}

export class DatabaseStorage implements IStorage {
  async createHubspotChangeLog(entry: InsertHubspotChangeLog): Promise<HubspotChangeLog> {
    const [row] = await db.insert(hubspotChangeLog).values(entry).returning();
    return row;
  }

  async listHubspotChangeLog(limit: number = 200): Promise<HubspotChangeLog[]> {
    return await db
      .select()
      .from(hubspotChangeLog)
      .orderBy(desc(hubspotChangeLog.createdAt))
      .limit(limit);
  }

  async getHubspotChangeLog(id: number): Promise<HubspotChangeLog | undefined> {
    const [row] = await db.select().from(hubspotChangeLog).where(eq(hubspotChangeLog.id, id));
    return row;
  }

  async updateHubspotChangeLogUndo(
    id: number,
    status: "undone" | "undo_failed",
    undoResult: unknown,
  ): Promise<HubspotChangeLog> {
    const [row] = await db
      .update(hubspotChangeLog)
      .set({ status, undoneAt: new Date(), undoResult })
      .where(eq(hubspotChangeLog.id, id))
      .returning();
    return row;
  }
}

export const storage = new DatabaseStorage();
