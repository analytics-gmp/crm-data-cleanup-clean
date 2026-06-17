import { pgTable, text, timestamp, serial, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Persisted change history for every applied HubSpot Sandbox fix. Each row
// captures enough state to UNDO the change:
//   • update: store before+after values per property; undo PATCHes "before" back.
//   • merge:  store full property snapshot of every secondary contact; undo
//             POSTs new contacts with those properties (HubSpot has no unmerge
//             API so this is reconstruct-only — new VIDs, no engagement
//             history). The UI labels this clearly.
export const hubspotChangeLog = pgTable("hubspot_change_log", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  actionId: text("action_id").notNull(),
  // "merge" | "update"
  kind: text("kind").notNull(),
  // Bucket label e.g. "duplicate-by-phone", "name-case", "email-typo"
  issueType: text("issue_type").notNull(),
  // Short human description for the table row
  summary: text("summary").notNull(),
  // Primary contact (merges only; null for updates)
  primaryContactId: text("primary_contact_id"),
  // All HubSpot contact IDs touched by the fix (primary first, then secondaries
  // for merges; single id for updates)
  affectedContactIds: text("affected_contact_ids").array().notNull(),
  // Structured detail used by the undo flow + the detail drawer.
  //   update: { contactId, before: {prop:value}, after: {prop:value} }
  //   merge:  { primaryId, primarySnapshot, secondaries:[{id,properties}], chosenProperties? }
  detail: jsonb("detail").notNull(),
  // Original apply result message (for the "what HubSpot said" line)
  resultMessage: text("result_message"),
  // "active" | "undone" | "undo_failed"
  status: text("status").notNull().default("active"),
  undoneAt: timestamp("undone_at"),
  // For merge undo: { recreatedIds:[...], skipped:[{id,reason}], message:"" }
  // For update undo: { message:"" }
  undoResult: jsonb("undo_result"),
});

export const insertHubspotChangeLogSchema = createInsertSchema(hubspotChangeLog).omit({
  id: true,
  createdAt: true,
});

export type InsertHubspotChangeLog = z.infer<typeof insertHubspotChangeLogSchema>;
export type HubspotChangeLog = typeof hubspotChangeLog.$inferSelect;
