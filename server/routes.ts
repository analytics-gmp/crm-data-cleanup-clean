import type { Express } from "express";
import { storage } from "./storage";
import {
  fetchAllHubSpotContacts as fetchAllSandboxContacts,
  analyzeContacts as analyzeSandboxContacts,
  collectActionsFromReport as collectSandboxActions,
  applyFix as applySandboxFix,
  buildMergePreview as buildSandboxMergePreview,
  getWritableContactPropertyKeys as getSandboxWritableContactKeys,
  snapshotContactsForUndo as snapshotSandboxContacts,
  undoUpdateFix as undoSandboxUpdateFix,
  undoMergeFix as undoSandboxMergeFix,
  deriveIssueTypeFromActionId as deriveSandboxIssueType,
  type ContactQualityReport as SandboxContactQualityReport,
  type ApplyFixResult as SandboxApplyFixResult,
  type ProposedFix as SandboxProposedFix,
} from "./hubspot-sandbox-analysis";

export async function registerRoutes(app: Express): Promise<void> {
  const HUBSPOT_QUALITY_TTL_MS = 30 * 60 * 1000;

  // ── HubSpot Sandbox contact data-quality ──────────────────────────
  // Reads from the SANDBOX HubSpot instance via HUBSPOT_SANDBOX_API_KEY. Has
  // its own independent cache.
  let hubspotSandboxCache: { payload: SandboxContactQualityReport; expiresAt: number } | null = null;
  let hubspotSandboxInFlight: Promise<SandboxContactQualityReport> | null = null;
  // Per-action lock: prevents two overlapping HTTP requests from applying the
  // same fix concurrently. Reads/writes here are safe because Node is single-
  // threaded and the check-and-add happens synchronously before any await.
  const sandboxApplyInFlight = new Set<string>();

  // Build + persist a change log row for a successfully-applied sandbox fix.
  async function writeSandboxChangeLogEntry(args: {
    actionId: string;
    fix: SandboxProposedFix;
    result: SandboxApplyFixResult;
    preMergeSnapshot: Map<string, Record<string, string | null>> | null;
    snapshotError: string | null;
    chosenProperties?: Record<string, string>;
  }): Promise<void> {
    const { actionId, fix, result, preMergeSnapshot, snapshotError, chosenProperties } = args;
    if (fix.kind === "manual") return; // nothing was applied
    const issueType = deriveSandboxIssueType(actionId, fix);
    if (fix.kind === "update") {
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      for (const row of fix.preview) {
        before[row.property] = row.from;
        after[row.property] = row.to;
      }
      await storage.createHubspotChangeLog({
        actionId,
        kind: "update",
        issueType,
        summary: fix.description,
        primaryContactId: null,
        affectedContactIds: [fix.contactId],
        detail: { contactId: fix.contactId, before, after },
        resultMessage: result.message ?? null,
        status: "active",
        undoneAt: null,
        undoResult: null,
      });
      return;
    }
    // merge — only log the contacts that were ACTUALLY deleted.
    const actuallyMergedIds = result.mergedSecondaryIds ?? fix.mergeContactIds;
    const secondaries: { id: string; properties: Record<string, string | null> }[] = [];
    if (preMergeSnapshot) {
      for (const secId of actuallyMergedIds) {
        const props = preMergeSnapshot.get(secId);
        if (props) secondaries.push({ id: secId, properties: props });
      }
    }
    const primarySnapshot = preMergeSnapshot?.get(fix.primaryContactId) ?? null;
    await storage.createHubspotChangeLog({
      actionId,
      kind: "merge",
      issueType,
      summary: fix.description,
      primaryContactId: fix.primaryContactId,
      affectedContactIds: [fix.primaryContactId, ...actuallyMergedIds],
      detail: {
        primaryId: fix.primaryContactId,
        primarySnapshot,
        secondaries,
        notDeleted: fix.mergeContactIds.filter(id => !actuallyMergedIds.includes(id)),
        chosenProperties: chosenProperties ?? null,
        snapshotError,
      },
      resultMessage: result.message ?? null,
      status: "active",
      undoneAt: null,
      undoResult: null,
    });
  }

  app.get("/api/hubspot/sandbox-contacts-quality", async (req, res) => {
    try {
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const now = Date.now();
      if (!refresh && hubspotSandboxCache && hubspotSandboxCache.expiresAt > now) {
        return res.json({ ...hubspotSandboxCache.payload, fromCache: true });
      }
      if (!hubspotSandboxInFlight) {
        hubspotSandboxInFlight = (async () => {
          try {
            console.log("[HubSpot Sandbox] Cold cache — pulling all contacts...");
            const fetched = await fetchAllSandboxContacts();
            console.log(`[HubSpot Sandbox] Pulled ${fetched.contacts.length} contacts (truncated=${fetched.wasTruncated}), analyzing...`);
            const report = analyzeSandboxContacts(fetched.contacts, {
              wasTruncated: fetched.wasTruncated,
              maxContactsConsidered: fetched.maxContactsConsidered,
            });
            hubspotSandboxCache = { payload: report, expiresAt: Date.now() + HUBSPOT_QUALITY_TTL_MS };
            console.log(`[HubSpot Sandbox] Done. ${report.summary.duplicateGroups} dup groups, ${report.summary.formattingIssues} fmt, ${report.summary.enrichmentOpportunities} enrich.`);
            return report;
          } finally {
            hubspotSandboxInFlight = null;
          }
        })();
      }
      const payload = await hubspotSandboxInFlight;
      res.json({ ...payload, fromCache: false });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[HubSpot Sandbox] Error:", message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/hubspot/sandbox-merge-preview?ids=a,b,c[&all=1]
  app.get("/api/hubspot/sandbox-merge-preview", async (req, res) => {
    try {
      const idsRaw = req.query.ids;
      if (typeof idsRaw !== "string" || !idsRaw) {
        return res.status(400).json({ error: "ids (comma-separated) is required" });
      }
      const ids = idsRaw.split(",").map(s => s.trim()).filter(Boolean);
      if (ids.length < 2) return res.status(400).json({ error: "Need at least 2 ids" });
      if (ids.length > 20) return res.status(400).json({ error: "Cannot preview more than 20 contacts at once" });
      for (const id of ids) {
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: `Invalid contact id: ${id}` });
      }
      const showAll = req.query.all === "1" || req.query.all === "true";
      const preview = await buildSandboxMergePreview(ids, { showAll });
      res.json(preview);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[HubSpot Sandbox Merge Preview] Error:", message);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/hubspot/sandbox-apply-fixes  Body: { actionIds: string[], overrides?: {...} }
  app.post("/api/hubspot/sandbox-apply-fixes", async (req, res) => {
    try {
      const body = req.body as { actionIds?: unknown; overrides?: unknown };
      if (!body || !Array.isArray(body.actionIds) || body.actionIds.length === 0) {
        return res.status(400).json({ error: "actionIds (non-empty array) is required" });
      }
      if (body.actionIds.length > 500) {
        return res.status(400).json({ error: "Cannot apply more than 500 fixes per request" });
      }
      const actionIds: string[] = [];
      for (const a of body.actionIds) {
        if (typeof a !== "string" || !a) return res.status(400).json({ error: "actionIds must be non-empty strings" });
        actionIds.push(a);
      }

      const overrides: Record<string, {
        chosenProperties?: Record<string, string>;
        primaryContactId?: string;
        mergeContactIds?: string[];
      }> = {};
      const overridesIn = body.overrides;
      if (overridesIn && typeof overridesIn === "object" && !Array.isArray(overridesIn)) {
        let writableKeys: Set<string> | null = null;
        const rejected: { actionId: string; key: string }[] = [];
        for (const [k, v] of Object.entries(overridesIn as Record<string, unknown>)) {
          if (!v || typeof v !== "object") continue;
          const o = v as { chosenProperties?: unknown; primaryContactId?: unknown; mergeContactIds?: unknown };
          const entry: { chosenProperties?: Record<string, string>; primaryContactId?: string; mergeContactIds?: string[] } = {};
          if (o.chosenProperties && typeof o.chosenProperties === "object" && !Array.isArray(o.chosenProperties)) {
            const sanitized: Record<string, string> = {};
            for (const [pk, pv] of Object.entries(o.chosenProperties as Record<string, unknown>)) {
              if (typeof pk !== "string" || !pk || typeof pv !== "string") continue;
              if (!writableKeys) {
                try {
                  writableKeys = await getSandboxWritableContactKeys();
                } catch (e: unknown) {
                  const m = e instanceof Error ? e.message : "Unknown error";
                  return res.status(500).json({ error: `Could not load writable property list: ${m}` });
                }
              }
              if (!writableKeys.has(pk)) {
                rejected.push({ actionId: k, key: pk });
                continue;
              }
              sanitized[pk] = pv;
            }
            if (Object.keys(sanitized).length > 0) entry.chosenProperties = sanitized;
          }
          if (typeof o.primaryContactId === "string" && /^\d+$/.test(o.primaryContactId)) {
            entry.primaryContactId = o.primaryContactId;
          }
          if (Array.isArray(o.mergeContactIds)) {
            const ids: string[] = [];
            for (const id of o.mergeContactIds) {
              if (typeof id === "string" && /^\d+$/.test(id)) ids.push(id);
            }
            if (ids.length > 0) entry.mergeContactIds = Array.from(new Set(ids));
          }
          if (entry.chosenProperties || entry.primaryContactId || entry.mergeContactIds) {
            overrides[k] = entry;
          }
        }
        if (rejected.length > 0) {
          return res.status(400).json({
            error: "One or more override properties are read-only or unknown to HubSpot. Remove them and try again.",
            rejected,
          });
        }
      }

      let report: SandboxContactQualityReport;
      const now = Date.now();
      if (hubspotSandboxCache && hubspotSandboxCache.expiresAt > now) {
        report = hubspotSandboxCache.payload;
      } else {
        console.log("[HubSpot Sandbox] Apply: cache cold — refreshing before applying...");
        const fetched = await fetchAllSandboxContacts();
        report = analyzeSandboxContacts(fetched.contacts, {
          wasTruncated: fetched.wasTruncated,
          maxContactsConsidered: fetched.maxContactsConsidered,
        });
        hubspotSandboxCache = { payload: report, expiresAt: Date.now() + HUBSPOT_QUALITY_TTL_MS };
      }

      const fixMap = collectSandboxActions(report);
      const results: SandboxApplyFixResult[] = [];
      let appliedCount = 0;
      let mutatedCount = 0;
      const lockedHere: string[] = [];
      try {
        for (const actionId of actionIds) {
          const fix = fixMap.get(actionId);
          if (!fix) {
            results.push({ actionId, status: "skipped", message: "Unknown action — refresh and try again." });
            continue;
          }
          if (sandboxApplyInFlight.has(actionId)) {
            results.push({ actionId, status: "skipped", message: "Already being applied by another request." });
            continue;
          }
          sandboxApplyInFlight.add(actionId);
          lockedHere.push(actionId);
          try {
            let fixToApply = fix;
            const ov = overrides[actionId];
            if (fix.kind === "merge" && ov && (ov.primaryContactId || ov.mergeContactIds)) {
              const originalSet = new Set([fix.primaryContactId, ...fix.mergeContactIds]);
              const newPrimary = ov.primaryContactId ?? fix.primaryContactId;
              const requestedSecondaries = ov.mergeContactIds ?? fix.mergeContactIds;
              if (!originalSet.has(newPrimary)) {
                results.push({ actionId, status: "skipped", message: `Selective merge: primary ${newPrimary} is not in the original duplicate group.` });
                continue;
              }
              const badSecondary = requestedSecondaries.find(id => !originalSet.has(id));
              if (badSecondary) {
                results.push({ actionId, status: "skipped", message: `Selective merge: contact ${badSecondary} is not in the original duplicate group.` });
                continue;
              }
              const newSecondaries = requestedSecondaries.filter(id => id !== newPrimary);
              if (newSecondaries.length === 0) {
                results.push({ actionId, status: "skipped", message: "Selective merge: need at least one contact to merge into the primary." });
                continue;
              }
              fixToApply = { ...fix, primaryContactId: newPrimary, mergeContactIds: newSecondaries };
            }

            let preMergeSnapshot: Map<string, Record<string, string | null>> | null = null;
            let snapshotError: string | null = null;
            if (fixToApply.kind === "merge") {
              try {
                preMergeSnapshot = await snapshotSandboxContacts([
                  fixToApply.primaryContactId,
                  ...fixToApply.mergeContactIds,
                ]);
              } catch (snapErr: unknown) {
                snapshotError = snapErr instanceof Error ? snapErr.message : "Unknown snapshot error";
                console.warn(`[HubSpot Sandbox] Snapshot failed for ${actionId}: ${snapshotError}`);
              }
            }

            const onBeforeSecondarySelfHeal = fixToApply.kind === "merge"
              ? async (canonicalId: string) => {
                  if (preMergeSnapshot && preMergeSnapshot.has(canonicalId)) return;
                  try {
                    const m = await snapshotSandboxContacts([canonicalId]);
                    if (!preMergeSnapshot) preMergeSnapshot = new Map();
                    const props = m.get(canonicalId);
                    if (props) preMergeSnapshot.set(canonicalId, props);
                  } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : "Unknown snapshot error";
                    console.warn(`[HubSpot Sandbox] Self-heal snapshot failed for ${canonicalId}: ${msg}`);
                  }
                }
              : undefined;
            const r = await applySandboxFix(actionId, fixToApply, overrides[actionId], { onBeforeSecondarySelfHeal });
            results.push(r);
            if (r.status === "applied") appliedCount++;
            if (r.status === "applied" || r.status === "partial") {
              mutatedCount++;
              try {
                await writeSandboxChangeLogEntry({
                  actionId,
                  fix: fixToApply,
                  result: r,
                  preMergeSnapshot,
                  snapshotError,
                  chosenProperties: overrides[actionId]?.chosenProperties,
                });
              } catch (logErr: unknown) {
                const m = logErr instanceof Error ? logErr.message : "Unknown error";
                console.error(`[HubSpot Sandbox] Failed to write change log for ${actionId}: ${m}`);
              }
            }
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : "Unknown error";
            results.push({ actionId, status: "failed", message });
          }
          await new Promise(r => setTimeout(r, 100));
        }
      } finally {
        for (const id of lockedHere) sandboxApplyInFlight.delete(id);
      }

      if (mutatedCount > 0) {
        hubspotSandboxCache = null;
      }

      const failed = results.filter(r => r.status === "failed").length;
      const skipped = results.filter(r => r.status === "skipped").length;
      const partial = results.filter(r => r.status === "partial").length;
      console.log(`[HubSpot Sandbox] Apply: ${appliedCount}/${actionIds.length} applied, ${partial} partial, ${failed} failed, ${skipped} skipped.`);
      res.json({ results, appliedCount, mutatedCount, totalRequested: actionIds.length });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[HubSpot Sandbox Apply] Error:", message);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/hubspot/sandbox-change-log
  app.get("/api/hubspot/sandbox-change-log", async (_req, res) => {
    try {
      const rows = await storage.listHubspotChangeLog(500);
      res.json({ entries: rows });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[HubSpot Sandbox Change Log] Error:", message);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/hubspot/sandbox-change-log/:id/undo
  app.post("/api/hubspot/sandbox-change-log/:id/undo", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid id" });
      }
      const entry = await storage.getHubspotChangeLog(id);
      if (!entry) return res.status(404).json({ error: "Change log entry not found" });
      if (entry.status === "undone") {
        return res.status(409).json({ error: "Already undone" });
      }
      const detail = entry.detail as any;
      if (entry.kind === "update") {
        const r = await undoSandboxUpdateFix(detail.contactId, detail.before || {});
        if (r.ok) {
          const updated = await storage.updateHubspotChangeLogUndo(id, "undone", {
            message: "Property values reverted in HubSpot.",
          });
          hubspotSandboxCache = null; // audit is now stale
          return res.json({ entry: updated });
        }
        const updated = await storage.updateHubspotChangeLogUndo(id, "undo_failed", { message: r.message });
        return res.status(502).json({ entry: updated, error: r.message });
      }
      if (entry.kind === "merge") {
        const secondaries: { id: string; properties: Record<string, string | null> }[] =
          Array.isArray(detail.secondaries) ? detail.secondaries : [];
        if (secondaries.length === 0) {
          const updated = await storage.updateHubspotChangeLogUndo(id, "undo_failed", {
            message: "No pre-merge snapshot was captured — undo is not available for this entry.",
          });
          return res.status(409).json({ entry: updated, error: "No snapshot available — cannot reconstruct." });
        }
        const result = await undoSandboxMergeFix(secondaries);
        const fullSuccess = result.skipped.length === 0;
        const status: "undone" | "undo_failed" = result.recreatedIds.length > 0 ? "undone" : "undo_failed";
        const undoResult = {
          recreatedIds: result.recreatedIds,
          skipped: result.skipped,
          strippedUniqueFieldsFor: result.strippedUniqueFields,
          message: fullSuccess
            ? `Reconstructed ${result.recreatedIds.length} contact(s) as NEW HubSpot records (engagement history is not restored).`
            : `Reconstructed ${result.recreatedIds.length} of ${secondaries.length}; ${result.skipped.length} could not be recreated.`,
        };
        const updated = await storage.updateHubspotChangeLogUndo(id, status, undoResult);
        if (status === "undone") hubspotSandboxCache = null;
        return res.json({ entry: updated });
      }
      return res.status(400).json({ error: `Unsupported kind: ${entry.kind}` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[HubSpot Sandbox Undo] Error:", message);
      res.status(500).json({ error: message });
    }
  });
}
