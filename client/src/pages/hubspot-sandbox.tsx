import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  ArrowLeft,
  RefreshCw,
  Users,
  Copy,
  Mail,
  MailWarning,
  Phone,
  User,
  AlertTriangle,
  Sparkles,
  ExternalLink,
  Wand2,
  Check,
  X,
  Loader2,
  Hand,
  Settings2,
  History,
  Undo2,
  ChevronDown,
  ChevronRight,
  Briefcase,
  Ticket,
  Building2,
} from "lucide-react";

// ── Change-log types (mirror shared/schema.ts hubspotChangeLog) ────────
interface ChangeLogEntry {
  id: number;
  createdAt: string;
  actionId: string;
  kind: "merge" | "update";
  issueType: string;
  summary: string;
  primaryContactId: string | null;
  affectedContactIds: string[];
  detail: any;
  resultMessage: string | null;
  status: "active" | "undone" | "undo_failed";
  undoneAt: string | null;
  undoResult: any;
}

// ── Types (mirror server/hubspot-sandbox-analysis.ts) ──────────────────
type ProposedFix =
  | {
      kind: "merge";
      primaryContactId: string;
      mergeContactIds: string[];
      description: string;
    }
  | {
      kind: "update";
      contactId: string;
      properties: Record<string, string>;
      preview: { property: string; from: string | null; to: string }[];
      description: string;
    }
  | {
      kind: "manual";
      contactId: string;
      description: string;
    };

interface ApplyFixResult {
  actionId: string;
  status: "applied" | "partial" | "failed" | "skipped";
  message?: string;
}

interface DuplicateGroup {
  key: string;
  reason: "email" | "phone" | "name" | "similar-email";
  contactIds: string[];
  sample: { id: string; name: string; email: string | null; phone: string | null; company: string | null }[];
  count: number;
  actionId: string;
  fix: ProposedFix;
}

interface ContactSample {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  hubspotUrl: string;
  detail?: string;
  actionId?: string;
  fix?: ProposedFix;
}

interface IssueBucket {
  id: string;
  label: string;
  description: string;
  count: number;
  samples: ContactSample[];
}

interface ContactQualityReport {
  generatedAt: string;
  totalContacts: number;
  wasTruncated: boolean;
  maxContactsConsidered: number;
  hubspotPortalId: string;
  summary: {
    duplicateGroups: number;
    duplicateContacts: number;
    formattingIssues: number;
    enrichmentOpportunities: number;
  };
  duplicates: {
    byEmail: DuplicateGroup[];
    byPhone: DuplicateGroup[];
    byName: DuplicateGroup[];
    bySimilarEmail: DuplicateGroup[];
  };
  duplicateTotals: {
    byEmail: number;
    byPhone: number;
    byName: number;
    bySimilarEmail: number;
  };
  formatting: IssueBucket[];
  enrichment: IssueBucket[];
  fromCache?: boolean;
}

type RowStatus = "applied" | "partial" | "failed" | "skipped" | "pending" | "idle";

interface MergePreviewContact {
  id: string;
  isPrimary: boolean;
  createdate: string | null;
  lastmodifieddate: string | null;
  /** Counts of HubSpot records associated with this contact. Surfaced in the
   *  customize-merge dialog so the user can see what each duplicate carries
   *  before deciding which to merge. HubSpot's merge transfers all of these
   *  to the primary so nothing is lost. */
  associationCounts: { deals: number; tickets: number; companies: number };
}
interface MergePreviewField {
  key: string;
  label: string;
  group: string;
  hasConflict: boolean;
  readOnly: boolean;
  values: Array<{ contactId: string; value: string | null }>;
}
interface MergePreview {
  primaryContactId: string;
  contacts: MergePreviewContact[];
  fields: MergePreviewField[];
  showingAllProperties: boolean;
  fieldCount: number;
  conflictCount: number;
}

interface ApplyContext {
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  applyOne: (id: string) => void;
  /** Run a single merge with user-chosen field values + an optional subset of
   *  the original duplicate group (selective merge). When `mergeContactIds`
   *  is shorter than the original group the remaining contacts stay separate
   *  and reappear in the next audit, ready to be reviewed/merged on their
   *  own. `primaryContactId` lets the user override the default
   *  oldest-wins primary pick. */
  applyCustomizedMerge: (
    actionId: string,
    chosenProperties: Record<string, string>,
    selective?: { primaryContactId: string; mergeContactIds: string[] },
  ) => void;
  statusOf: (id: string) => { status: RowStatus; message?: string };
  /** True while ANY apply is in flight — used to disable every Apply trigger
   *  on the page so two concurrent requests can't race against the same row. */
  applyInFlight: boolean;
}

// ── Small UI helpers ───────────────────────────────────────────────────
function StatCard({ icon, label, value, hint, testid }: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  hint?: string;
  testid: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
            {value === null ? (
              <Skeleton className="h-8 w-20 mt-2" />
            ) : (
              <p className="text-3xl font-bold mt-1" data-testid={testid}>{value}</p>
            )}
            {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
          </div>
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-muted text-muted-foreground">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, message }: { status: RowStatus; message?: string }) {
  if (status === "idle") return null;
  if (status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-status-pending">
        <Loader2 className="w-3 h-3 animate-spin" /> Applying…
      </Badge>
    );
  }
  if (status === "applied") {
    return (
      <Badge variant="default" className="gap-1 bg-green-600 hover:bg-green-600" data-testid="badge-status-applied">
        <Check className="w-3 h-3" /> Applied
      </Badge>
    );
  }
  if (status === "partial") {
    return (
      <Badge variant="default" className="gap-1 bg-amber-600 hover:bg-amber-600" title={message} data-testid="badge-status-partial">
        <AlertTriangle className="w-3 h-3" /> Partial
      </Badge>
    );
  }
  if (status === "skipped") {
    return (
      <Badge variant="outline" className="gap-1" title={message} data-testid="badge-status-skipped">
        <Hand className="w-3 h-3" /> Manual
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1" title={message} data-testid="badge-status-failed">
      <X className="w-3 h-3" /> Failed
    </Badge>
  );
}

function FixPreview({ fix }: { fix: ProposedFix }) {
  if (fix.kind === "manual") {
    return (
      <div className="text-xs text-muted-foreground italic flex items-start gap-1.5 mt-1">
        <Hand className="w-3 h-3 mt-0.5 shrink-0" />
        <span>{fix.description}</span>
      </div>
    );
  }
  if (fix.kind === "merge") {
    return (
      <div className="text-xs text-muted-foreground mt-1 flex items-start gap-1.5">
        <Wand2 className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
        <span>{fix.description}</span>
      </div>
    );
  }
  return (
    <div className="text-xs mt-1 space-y-0.5">
      <div className="flex items-start gap-1.5 text-muted-foreground">
        <Wand2 className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
        <span>{fix.description}</span>
      </div>
      <div className="ml-4 font-mono text-[11px] text-muted-foreground/80">
        {fix.preview.map((p, i) => (
          <div key={i}>
            <span className="text-muted-foreground/60">{p.property}:</span>{" "}
            <span className="line-through">{p.from ?? "(empty)"}</span>{" "}
            <span className="text-foreground">→ {p.to}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Plain contact row (used inside duplicate groups for member display) ─
function ContactRow({ s, portalId }: {
  s: { id: string; name: string; email: string | null; phone: string | null; company: string | null };
  portalId: string;
}) {
  const url = `https://app.hubspot.com/contacts/${portalId}/contact/${s.id}`;
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/50 last:border-0" data-testid={`contact-row-${s.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{s.name}</span>
          {s.company && <span className="text-xs text-muted-foreground truncate">· {s.company}</span>}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          {s.email && <span className="flex items-center gap-1 truncate"><Mail className="w-3 h-3" />{s.email}</span>}
          {s.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{s.phone}</span>}
        </div>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
        data-testid={`link-hubspot-${s.id}`}
      >
        Open <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

// ── Actionable row used inside formatting/enrichment buckets ───────────
function ActionableRow({ s, ctx }: { s: ContactSample; ctx: ApplyContext }) {
  const fix = s.fix;
  const actionId = s.actionId;
  const status = actionId ? ctx.statusOf(actionId) : { status: "idle" as RowStatus };
  const isManual = !fix || fix.kind === "manual";
  const isApplied = status.status === "applied";
  const isPending = status.status === "pending";
  const checkable = !!actionId && !isManual && !isApplied;
  return (
    <div
      className={`flex items-start gap-3 py-2 border-b border-border/50 last:border-0 ${isApplied ? "opacity-50" : ""}`}
      data-testid={`issue-row-${s.id}`}
    >
      <div className="pt-1.5">
        <Checkbox
          checked={actionId ? ctx.selected.has(actionId) : false}
          onCheckedChange={() => actionId && ctx.toggleSelect(actionId)}
          disabled={!checkable}
          aria-label="Select fix"
          data-testid={`checkbox-fix-${actionId ?? s.id}`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">{s.name}</span>
          {s.company && <span className="text-xs text-muted-foreground truncate">· {s.company}</span>}
          <StatusBadge status={status.status} message={status.message} />
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
          {s.email && <span className="flex items-center gap-1 truncate"><Mail className="w-3 h-3" />{s.email}</span>}
          {s.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{s.phone}</span>}
          {s.detail && <span className="italic truncate">{s.detail}</span>}
        </div>
        {fix && <FixPreview fix={fix} />}
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        {!isManual && actionId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => ctx.applyOne(actionId)}
            disabled={isPending || isApplied || ctx.applyInFlight}
            data-testid={`button-apply-${actionId}`}
          >
            {isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Wand2 className="w-3 h-3 mr-1" />}
            Apply
          </Button>
        )}
        <a
          href={s.hubspotUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1"
          data-testid={`link-hubspot-${s.id}`}
        >
          Open <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

function reasonLabel(r: DuplicateGroup["reason"]): { label: string; tip: string } {
  if (r === "email") return { label: "Same email", tip: "Merge using HubSpot's contact merge tool — email is the safest dedup key." };
  if (r === "phone") return { label: "Same phone (normalized)", tip: "Investigate before merging — multiple people may share a household line. Verify the contacts are actually the same person before merging." };
  if (r === "similar-email") return { label: "Similar email (likely typo)", tip: "Two emails differ by a single character — usually a typo on data entry. Confirm which spelling is correct, fix the wrong one, then merge." };
  return { label: "Same name", tip: "Same first and last name. Could be the same person across multiple records, or two different people who share a name — confirm via email or phone before merging." };
}

function DuplicateGroupCard({ g, portalId, ctx }: { g: DuplicateGroup; portalId: string; ctx: ApplyContext }) {
  const r = reasonLabel(g.reason);
  const status = ctx.statusOf(g.actionId);
  const isApplied = status.status === "applied";
  const isPending = status.status === "pending";
  const primaryId = g.fix.kind === "merge" ? g.fix.primaryContactId : null;
  const [customizeOpen, setCustomizeOpen] = useState(false);
  return (
    <Card className={`overflow-hidden ${isApplied ? "opacity-50" : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <Checkbox
              checked={ctx.selected.has(g.actionId)}
              onCheckedChange={() => ctx.toggleSelect(g.actionId)}
              disabled={isApplied}
              aria-label="Select merge"
              className="mt-1"
              data-testid={`checkbox-fix-${g.actionId}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary">{r.label}</Badge>
                <span className="text-sm font-medium">{g.count} contacts</span>
                <StatusBadge status={status.status} message={status.message} />
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate" title={g.key}>
                Key: <span className="font-mono">{g.key}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 items-end shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => ctx.applyOne(g.actionId)}
              disabled={isPending || isApplied || ctx.applyInFlight}
              data-testid={`button-apply-${g.actionId}`}
            >
              {isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Wand2 className="w-3 h-3 mr-1" />}
              Merge
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCustomizeOpen(true)}
              disabled={isApplied || isPending || ctx.applyInFlight}
              data-testid={`button-customize-${g.actionId}`}
            >
              <Settings2 className="w-3 h-3 mr-1" />
              Customize
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted-foreground mb-2">{r.tip}</p>
        <div className="text-xs text-muted-foreground mb-2 flex items-start gap-1.5">
          <Wand2 className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
          <span>{g.fix.description}</span>
        </div>
        <div className="rounded-md border border-border/50 p-2">
          {g.sample.map(s => (
            <div key={s.id} className="relative">
              {primaryId === s.id && (
                <Badge variant="outline" className="absolute -top-1 right-0 text-[10px] py-0 px-1.5 z-10 bg-background">
                  primary (kept)
                </Badge>
              )}
              <ContactRow s={s} portalId={portalId} />
            </div>
          ))}
          {g.count > g.sample.length && (
            <p className="text-xs text-muted-foreground mt-2 italic">
              + {g.count - g.sample.length} more in this group
            </p>
          )}
        </div>
      </CardContent>
      {g.fix.kind === "merge" && (
        <MergeCustomizeDialog
          open={customizeOpen}
          onOpenChange={setCustomizeOpen}
          group={g}
          onConfirm={(chosenProperties, selective) => {
            setCustomizeOpen(false);
            ctx.applyCustomizedMerge(g.actionId, chosenProperties, selective);
          }}
          applying={isPending || ctx.applyInFlight}
        />
      )}
    </Card>
  );
}

// ── Customize-merge dialog ─────────────────────────────────────────────
// Shows a per-field comparison across the primary + every secondary so the
// user can override which value lands on the merged record. The chosen
// property values are PATCHed onto the primary BEFORE the merge runs, taking
// advantage of HubSpot's primary-wins-on-conflict rule.
function MergeCustomizeDialog({
  open,
  onOpenChange,
  group,
  onConfirm,
  applying,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: DuplicateGroup;
  onConfirm: (
    chosenProperties: Record<string, string>,
    selective?: { primaryContactId: string; mergeContactIds: string[] },
  ) => void;
  applying: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [showOnlyConflicts, setShowOnlyConflicts] = useState(true);
  // field key -> contactId of the picked value
  const [picks, setPicks] = useState<Map<string, string>>(new Map());
  // Selective-merge state: which contacts in the group to actually merge,
  // and which one to keep as the primary. Initialized from server preview
  // (all included, server's oldest-wins primary). Both can be edited per
  // contact column header so the user can:
  //   • exclude a row entirely (it stays as its own contact, reappears in
  //     the next audit so it can be merged separately or left alone), and
  //   • promote any included contact to primary (the one that's KEPT).
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [primaryId, setPrimaryId] = useState<string>("");

  const ids = useMemo(() => {
    if (group.fix.kind !== "merge") return [];
    return [group.fix.primaryContactId, ...group.fix.mergeContactIds];
  }, [group]);

  const previewQuery = useQuery<MergePreview>({
    queryKey: ["/api/hubspot/sandbox-merge-preview", ids.join(","), showAll ? "all" : "useful"],
    queryFn: async () => {
      const params = new URLSearchParams({ ids: ids.join(",") });
      if (showAll) params.set("all", "1");
      const res = await fetch(`/api/hubspot/sandbox-merge-preview?${params.toString()}`);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Preview failed (${res.status})`);
      }
      return (await res.json()) as MergePreview;
    },
    enabled: open && ids.length >= 2,
  });

  // Initialize picks/inclusion/primary ONCE per dialog-open per group. We
  // intentionally do NOT re-initialize on every previewQuery.data change —
  // background refetches or toggling "show all properties" would otherwise
  // wipe the user's in-progress selections. The dialog's open/close cycle
  // (and the actionId-changing group prop) are what should reset state.
  const initializedKey = useRef<string | null>(null);
  const sessionKey = open ? `${group.actionId}` : null;
  useEffect(() => {
    if (!previewQuery.data || !sessionKey) return;
    if (initializedKey.current === sessionKey) {
      // Already initialized this dialog session. New field data may have
      // arrived (e.g. show-all toggled) — extend picks for any newly-seen
      // field keys without disturbing existing user picks.
      setPicks(prev => {
        const next = new Map(prev);
        for (const f of previewQuery.data!.fields) {
          if (!next.has(f.key)) next.set(f.key, primaryId || previewQuery.data!.primaryContactId);
        }
        return next;
      });
      return;
    }
    const next = new Map<string, string>();
    for (const f of previewQuery.data.fields) {
      next.set(f.key, previewQuery.data.primaryContactId);
    }
    setPicks(next);
    setIncludedIds(new Set(previewQuery.data.contacts.map(c => c.id)));
    setPrimaryId(previewQuery.data.primaryContactId);
    initializedKey.current = sessionKey;
  }, [previewQuery.data, sessionKey, primaryId]);

  // Reset the init flag when the dialog closes so reopening starts fresh.
  useEffect(() => {
    if (!open) initializedKey.current = null;
  }, [open]);

  // Recompute conflicts ONLY across the contacts the user is including, so
  // excluding a duplicate doesn't leave its (now-irrelevant) value still
  // flagged as a conflict.
  const fieldsForIncluded = useMemo(() => {
    if (!previewQuery.data) return [];
    return previewQuery.data.fields.map(f => {
      const inc = f.values.filter(v => includedIds.has(v.contactId));
      const distinct = new Set(inc.map(v => (v.value ?? "").trim()));
      return { ...f, hasConflict: distinct.size > 1 };
    });
  }, [previewQuery.data, includedIds]);

  const visibleFields = useMemo(() => {
    return showOnlyConflicts ? fieldsForIncluded.filter(f => f.hasConflict) : fieldsForIncluded;
  }, [fieldsForIncluded, showOnlyConflicts]);

  const conflictCountIncluded = useMemo(
    () => fieldsForIncluded.filter(f => f.hasConflict).length,
    [fieldsForIncluded],
  );

  // Override count = picks pointing to a non-primary INCLUDED contact. A pick
  // referencing an excluded contact is ignored (treated as "primary wins"
  // since that contact's data isn't part of the merge).
  const overridesCount = useMemo(() => {
    if (!previewQuery.data) return 0;
    let c = 0;
    for (const f of fieldsForIncluded) {
      const pickId = picks.get(f.key);
      if (pickId && pickId !== primaryId && includedIds.has(pickId)) c++;
    }
    return c;
  }, [previewQuery.data, fieldsForIncluded, picks, primaryId, includedIds]);

  function toggleInclude(contactId: string) {
    setIncludedIds(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) {
        // Don't allow excluding the primary; user must demote it first.
        if (contactId === primaryId) return prev;
        next.delete(contactId);
      } else {
        next.add(contactId);
      }
      return next;
    });
    // Reset any picks pointing at the now-excluded contact back to primary
    // so the override count reflects reality.
    setPicks(prev => {
      const next = new Map(prev);
      Array.from(next.entries()).forEach(([k, v]) => { if (v === contactId) next.set(k, primaryId); });
      return next;
    });
  }

  function makePrimary(contactId: string) {
    const oldPrimary = primaryId;
    setPrimaryId(contactId);
    // Promoting a contact to primary auto-includes it (can't be primary AND
    // excluded).
    setIncludedIds(prev => {
      const next = new Set(prev);
      next.add(contactId);
      return next;
    });
    // Remap picks: every field that defaulted to the OLD primary should now
    // default to the NEW primary, otherwise those picks would silently become
    // overrides (writing the old primary's value onto the new primary).
    // Genuine user overrides (picks pointing at OTHER contacts) are preserved.
    if (oldPrimary && oldPrimary !== contactId) {
      setPicks(prev => {
        const next = new Map(prev);
        Array.from(next.entries()).forEach(([k, v]) => {
          if (v === oldPrimary) next.set(k, contactId);
        });
        return next;
      });
    }
  }

  function handleConfirm() {
    if (!previewQuery.data) return;
    const chosen: Record<string, string> = {};
    for (const f of fieldsForIncluded) {
      if (f.readOnly) continue;
      const pickId = picks.get(f.key);
      if (!pickId || pickId === primaryId || !includedIds.has(pickId)) continue;
      const v = f.values.find(x => x.contactId === pickId);
      if (v) chosen[f.key] = v.value ?? "";
    }
    // Only flag selective merge to the server when the user actually narrowed
    // the group or promoted a different primary — avoids unnecessary override
    // payloads for plain custom-field merges.
    const serverPrimary = previewQuery.data.primaryContactId;
    const serverIds = previewQuery.data.contacts.map(c => c.id);
    const isSelective =
      primaryId !== serverPrimary ||
      includedIds.size !== serverIds.length ||
      serverIds.some(id => !includedIds.has(id));
    if (isSelective) {
      const secondaries = Array.from(includedIds).filter(id => id !== primaryId);
      onConfirm(chosen, { primaryContactId: primaryId, mergeContactIds: secondaries });
    } else {
      onConfirm(chosen);
    }
  }

  const numContacts = previewQuery.data?.contacts.length ?? ids.length;
  const gridCols = `200px repeat(${numContacts}, minmax(160px, 1fr))`;
  const includedCount = includedIds.size;
  const canApply =
    !!previewQuery.data &&
    !applying &&
    includedCount >= 2 &&
    includedIds.has(primaryId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col" data-testid="dialog-customize-merge">
        <DialogHeader>
          <DialogTitle>Customize merge</DialogTitle>
          <DialogDescription>
            Decide which contacts to merge, which one to keep as primary, and which value
            wins for each conflicting field. HubSpot transfers <strong>every deal, ticket,
            company, and engagement</strong> (calls, notes, emails, meetings, tasks) from the
            other contacts onto the primary — nothing is lost. Uncheck a row to keep that
            contact separate; it'll show up again in the next audit so you can merge a different
            subset (e.g. split a group of 5 into two merges).
          </DialogDescription>
        </DialogHeader>

        {previewQuery.isLoading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground" data-testid="customize-loading">
            <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading contact data…
          </div>
        )}
        {previewQuery.isError && (
          <div className="py-6 px-4 text-destructive text-sm" data-testid="customize-error">
            Failed to load merge preview: {(previewQuery.error as Error)?.message || "unknown error"}
          </div>
        )}

        {previewQuery.data && (
          <>
            <div className="flex items-center gap-4 flex-wrap pt-2 pb-2 border-b">
              <div className="flex items-center gap-2">
                <Switch
                  id="conflicts-only"
                  checked={showOnlyConflicts}
                  onCheckedChange={setShowOnlyConflicts}
                  data-testid="switch-conflicts-only"
                />
                <Label htmlFor="conflicts-only" className="text-xs cursor-pointer">
                  Conflicts only ({conflictCountIncluded})
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="show-all"
                  checked={showAll}
                  onCheckedChange={setShowAll}
                  data-testid="switch-show-all"
                />
                <Label htmlFor="show-all" className="text-xs cursor-pointer">
                  Show all properties ({previewQuery.data.fieldCount}{showAll ? "" : "+"})
                </Label>
              </div>
              <span className="text-xs text-muted-foreground ml-auto flex items-center gap-3" data-testid="text-overrides-count">
                <span data-testid="text-included-count">
                  Merging <strong>{includedCount}</strong> of {previewQuery.data.contacts.length}
                </span>
                <span>·</span>
                <span>{overridesCount} override{overridesCount === 1 ? "" : "s"} from primary</span>
              </span>
            </div>

            <ScrollArea className="flex-1 -mx-2 max-h-[55vh]">
              <div className="px-2">
                <div
                  className="grid gap-2 text-xs font-medium text-muted-foreground py-2 sticky top-0 bg-background z-10 border-b"
                  style={{ gridTemplateColumns: gridCols }}
                >
                  <div>Field</div>
                  {previewQuery.data.contacts.map(c => {
                    const included = includedIds.has(c.id);
                    const isPrim = primaryId === c.id;
                    const counts = c.associationCounts ?? { deals: 0, tickets: 0, companies: 0 };
                    return (
                      <div
                        key={c.id}
                        className={`flex flex-col gap-1.5 p-1.5 rounded border ${
                          isPrim
                            ? "border-primary bg-primary/5"
                            : included
                              ? "border-border/50"
                              : "border-dashed border-border/40 bg-muted/30 opacity-60"
                        }`}
                        data-testid={`header-contact-${c.id}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={included}
                            disabled={isPrim}
                            onChange={() => toggleInclude(c.id)}
                            className="cursor-pointer disabled:cursor-not-allowed"
                            title={isPrim ? "Primary can't be excluded — promote a different contact first" : included ? "Uncheck to keep this contact separate" : "Include in this merge"}
                            data-testid={`checkbox-include-${c.id}`}
                          />
                          {isPrim ? (
                            <Badge className="bg-primary text-primary-foreground text-[10px] py-0 px-1">primary (kept)</Badge>
                          ) : included ? (
                            <button
                              type="button"
                              onClick={() => makePrimary(c.id)}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:border-primary hover:text-primary transition-colors"
                              title="Promote this contact to primary (the one HubSpot keeps)"
                              data-testid={`button-make-primary-${c.id}`}
                            >
                              Make primary
                            </button>
                          ) : (
                            <span className="text-[10px] text-muted-foreground italic">excluded</span>
                          )}
                        </div>
                        <span className="font-mono text-[11px] truncate" title={c.id}>{c.id}</span>
                        <div className="flex flex-wrap gap-1" title="Associations that will be transferred to the primary on merge">
                          <Badge variant="outline" className="text-[10px] py-0 px-1 gap-0.5" data-testid={`badge-deals-${c.id}`}>
                            <Briefcase className="w-2.5 h-2.5" /> {counts.deals}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] py-0 px-1 gap-0.5" data-testid={`badge-tickets-${c.id}`}>
                            <Ticket className="w-2.5 h-2.5" /> {counts.tickets}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] py-0 px-1 gap-0.5" data-testid={`badge-companies-${c.id}`}>
                            <Building2 className="w-2.5 h-2.5" /> {counts.companies}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {visibleFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    {showOnlyConflicts
                      ? "No conflicting fields — every contact agrees."
                      : "No fields to display."}
                  </p>
                ) : (
                  visibleFields.map(f => {
                    const pickedId = picks.get(f.key);
                    return (
                      <div
                        key={f.key}
                        className="grid gap-2 items-start py-2 border-b border-border/30"
                        style={{ gridTemplateColumns: gridCols }}
                        data-testid={`field-row-${f.key}`}
                      >
                        <div className="text-xs">
                          <div className="font-medium">{f.label}</div>
                          <div className="text-[10px] text-muted-foreground font-mono truncate" title={f.key}>{f.key}</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {f.hasConflict && (
                              <Badge variant="outline" className="text-[10px] py-0 px-1 border-amber-500 text-amber-700 dark:text-amber-400">
                                conflict
                              </Badge>
                            )}
                            {f.readOnly && (
                              <Badge variant="outline" className="text-[10px] py-0 px-1 border-muted-foreground/40 text-muted-foreground" title="HubSpot calculated/read-only — values shown for reference; cannot be overridden during merge.">
                                read-only
                              </Badge>
                            )}
                          </div>
                        </div>
                        {previewQuery.data.contacts.map(c => {
                          const v = f.values.find(x => x.contactId === c.id);
                          const isPicked = pickedId === c.id;
                          const isEmpty = !v?.value;
                          const isExcluded = !includedIds.has(c.id);
                          const baseClass = "text-left text-xs p-2 rounded border transition-colors";
                          if (f.readOnly || isExcluded) {
                            return (
                              <div
                                key={c.id}
                                className={`${baseClass} border-dashed border-border/50 bg-muted/20 text-muted-foreground cursor-not-allowed`}
                                data-testid={`pick-${f.key}-${c.id}-${isExcluded ? "excluded" : "readonly"}`}
                                title={isExcluded ? "Contact excluded from this merge" : "Read-only field — cannot be overridden during merge"}
                              >
                                {isEmpty ? <span className="italic">(empty)</span> : <span className="break-all">{v?.value}</span>}
                              </div>
                            );
                          }
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() =>
                                setPicks(prev => {
                                  const n = new Map(prev);
                                  n.set(f.key, c.id);
                                  return n;
                                })
                              }
                              className={`${baseClass} ${
                                isPicked
                                  ? "border-primary bg-primary/10 ring-1 ring-primary"
                                  : "border-border/50 hover:border-border hover:bg-muted/50"
                              }`}
                              data-testid={`pick-${f.key}-${c.id}`}
                            >
                              {isEmpty ? (
                                <span className="italic text-muted-foreground">(empty)</span>
                              ) : (
                                <span className="break-all">{v?.value}</span>
                              )}
                              {isPicked && <Check className="w-3 h-3 inline-block ml-1 text-primary" />}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </>
        )}

        <DialogFooter className="border-t pt-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={applying}
            data-testid="button-customize-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!canApply}
            title={
              !previewQuery.data
                ? "Loading…"
                : includedCount < 2
                  ? "Pick at least 2 contacts to merge"
                  : !includedIds.has(primaryId)
                    ? "Primary must be one of the included contacts"
                    : undefined
            }
            data-testid="button-customize-apply"
          >
            {applying ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Wand2 className="w-3 h-3 mr-1" />}
            Merge {includedCount} contact{includedCount === 1 ? "" : "s"}
            {overridesCount > 0 ? ` (${overridesCount} override${overridesCount === 1 ? "" : "s"})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IssueBucketCard({ b, ctx }: { b: IssueBucket; ctx: ApplyContext }) {
  return (
    <AccordionItem value={b.id} className="border rounded-lg px-4">
      <AccordionTrigger className="hover:no-underline" data-testid={`accordion-${b.id}`}>
        <div className="flex items-center gap-3 flex-1 text-left">
          <Badge variant="secondary" className="font-mono">{b.count.toLocaleString()}</Badge>
          <div className="flex-1 min-w-0">
            <p className="font-medium">{b.label}</p>
            <p className="text-xs text-muted-foreground font-normal mt-0.5">{b.description}</p>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent>
        <div className="rounded-md border border-border/50 p-2 mt-2">
          {b.samples.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">No samples available.</p>
          ) : (
            <>
              {b.samples.map(s => <ActionableRow key={s.id} s={s} ctx={ctx} />)}
              {b.count > b.samples.length && (
                <p className="text-xs text-muted-foreground mt-2 italic px-2">
                  Showing first {b.samples.length} of {b.count.toLocaleString()}.
                </p>
              )}
            </>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

// ── Change log (Activity) tab ──────────────────────────────────────────
// Renders the persisted audit history. Each row is expandable to show the
// full before/after detail. The undo button hands the entry up to the parent
// which renders a confirmation dialog before calling the undo endpoint.
function ChangeLogTab(props: {
  entries: ChangeLogEntry[];
  isLoading: boolean;
  expandedIds: Set<number>;
  onToggleExpand: (id: number) => void;
  onUndoClick: (entry: ChangeLogEntry) => void;
  undoingId: number | null;
}) {
  const { entries, isLoading, expandedIds, onToggleExpand, onUndoClick, undoingId } = props;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground" data-testid="text-no-activity">
          No fixes have been applied yet. Apply a fix from the Duplicates, Formatting,
          or Enrichment tabs and it will show up here.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Change history</CardTitle>
        <CardDescription>
          Every fix applied through this dashboard is recorded here, newest first.
          Click a row to see the full before/after detail. Use Undo to revert a
          property change, or to <em>reconstruct</em> the secondary contact(s) from
          a merge — note that HubSpot has no unmerge API, so reconstructed contacts
          come back with new ids and no engagement history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {entries.map(entry => (
            <ChangeLogRow
              key={entry.id}
              entry={entry}
              expanded={expandedIds.has(entry.id)}
              onToggleExpand={() => onToggleExpand(entry.id)}
              onUndoClick={() => onUndoClick(entry)}
              undoing={undoingId === entry.id}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ChangeLogRow(props: {
  entry: ChangeLogEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  onUndoClick: () => void;
  undoing: boolean;
}) {
  const { entry, expanded, onToggleExpand, onUndoClick, undoing } = props;
  const when = new Date(entry.createdAt);
  const whenLabel = when.toLocaleString();
  const isMerge = entry.kind === "merge";
  const numContacts = entry.affectedContactIds.length;
  // For merges with no snapshot we cannot undo at all; mark the button.
  const undoUnavailable = isMerge && (!entry.detail?.secondaries || entry.detail.secondaries.length === 0);
  const statusBadge = entry.status === "active"
    ? <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800">Active</Badge>
    : entry.status === "undone"
      ? <Badge variant="secondary">Undone</Badge>
      : <Badge variant="destructive">Undo failed</Badge>;
  return (
    <div className="border rounded-md" data-testid={`row-changelog-${entry.id}`}>
      <div className="flex items-center gap-3 p-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onToggleExpand}
          data-testid={`button-expand-${entry.id}`}
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </Button>
        <div className="shrink-0">
          {isMerge
            ? <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100"><Copy className="w-3 h-3 mr-1" />Merge</Badge>
            : <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100"><Wand2 className="w-3 h-3 mr-1" />Update</Badge>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate" data-testid={`text-summary-${entry.id}`}>{entry.summary}</div>
          <div className="text-xs text-muted-foreground truncate">
            {whenLabel} · {numContacts} contact{numContacts === 1 ? "" : "s"} · {entry.issueType}
          </div>
        </div>
        <div className="shrink-0">{statusBadge}</div>
        <Button
          size="sm"
          variant="outline"
          disabled={entry.status === "undone" || undoing || undoUnavailable}
          onClick={onUndoClick}
          data-testid={`button-undo-${entry.id}`}
          title={undoUnavailable ? "No pre-merge snapshot was captured — undo unavailable" : undefined}
        >
          {undoing ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <Undo2 className="w-3 h-3 mr-2" />}
          Undo
        </Button>
      </div>
      {expanded && <ChangeLogDetail entry={entry} />}
    </div>
  );
}

function ChangeLogDetail({ entry }: { entry: ChangeLogEntry }) {
  const isMerge = entry.kind === "merge";
  return (
    <div className="border-t p-3 bg-muted/30 text-sm space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        <div><span className="text-muted-foreground">Action id:</span> <code className="text-[11px]">{entry.actionId}</code></div>
        <div>
          <span className="text-muted-foreground">Affected contact ids:</span>{" "}
          {entry.affectedContactIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <a
                href={`https://app.hubspot.com/contacts/_/contact/${id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
                data-testid={`link-contact-${entry.id}-${id}`}
              >
                {id}
                {isMerge && i === 0 ? " (primary)" : ""}
              </a>
            </span>
          ))}
        </div>
      </div>

      {entry.resultMessage && (
        <div className="text-xs text-muted-foreground border-l-2 border-muted pl-2">
          <strong>HubSpot said:</strong> {entry.resultMessage}
        </div>
      )}

      {/* Update detail: show the property table */}
      {!isMerge && entry.detail?.before && entry.detail?.after && (
        <div className="space-y-1">
          <div className="font-medium text-xs">Property changes</div>
          <div className="rounded border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2">Property</th>
                  <th className="text-left p-2">Before</th>
                  <th className="text-left p-2">After</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(entry.detail.after).map(prop => (
                  <tr key={prop} className="border-t">
                    <td className="p-2 font-mono">{prop}</td>
                    <td className="p-2 text-muted-foreground">{String(entry.detail.before?.[prop] ?? "(empty)")}</td>
                    <td className="p-2">{String(entry.detail.after?.[prop] ?? "(empty)")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Merge detail: show chosen overrides + per-secondary saved fields */}
      {isMerge && (
        <div className="space-y-3">
          {entry.detail?.chosenProperties && Object.keys(entry.detail.chosenProperties).length > 0 && (
            <div className="space-y-1">
              <div className="font-medium text-xs">Saved into the primary (customize-merge picks)</div>
              <div className="rounded border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-2">Property</th>
                      <th className="text-left p-2">Value kept</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(entry.detail.chosenProperties as Record<string, string>).map(([k, v]) => (
                      <tr key={k} className="border-t">
                        <td className="p-2 font-mono">{k}</td>
                        <td className="p-2">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {Array.isArray(entry.detail?.secondaries) && entry.detail.secondaries.length > 0 ? (
            <div className="space-y-2">
              <div className="font-medium text-xs">
                Pre-merge snapshot (used to reconstruct on undo)
              </div>
              {entry.detail.secondaries.map((sec: any) => {
                const p = sec.properties || {};
                const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || "(no name)";
                return (
                  <div key={sec.id} className="rounded border p-2 bg-background">
                    <div className="text-xs font-medium">
                      Secondary <code>{sec.id}</code> — {name}
                    </div>
                    <div className="text-xs text-muted-foreground grid grid-cols-1 md:grid-cols-2 gap-x-4">
                      {p.email && <div><strong>email:</strong> {p.email}</div>}
                      {p.phone && <div><strong>phone:</strong> {p.phone}</div>}
                      {p.mobilephone && <div><strong>mobile:</strong> {p.mobilephone}</div>}
                      {p.company && <div><strong>company:</strong> {p.company}</div>}
                      {p.jobtitle && <div><strong>job title:</strong> {p.jobtitle}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-amber-700 dark:text-amber-400">
              No pre-merge snapshot was captured for this entry — undo is unavailable.
              {entry.detail?.snapshotError && <> Reason: {entry.detail.snapshotError}</>}
            </div>
          )}
        </div>
      )}

      {entry.status !== "active" && entry.undoResult && (
        <div className="text-xs border-l-2 border-primary pl-2">
          <strong>Undo result ({entry.undoneAt ? new Date(entry.undoneAt).toLocaleString() : "—"}):</strong>{" "}
          {entry.undoResult.message}
          {Array.isArray(entry.undoResult.recreatedIds) && entry.undoResult.recreatedIds.length > 0 && (
            <> New contact ids: {entry.undoResult.recreatedIds.map((id: string, i: number) => (
              <span key={id}>
                {i > 0 && ", "}
                <a
                  href={`https://app.hubspot.com/contacts/_/contact/${id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >{id}</a>
              </span>
            ))}.</>
          )}
          {Array.isArray(entry.undoResult.skipped) && entry.undoResult.skipped.length > 0 && (
            <div className="mt-1 text-destructive">
              Could not recreate: {entry.undoResult.skipped.map((s: any) => `${s.originalId} (${s.reason})`).join("; ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────
export default function HubSpotSandbox() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [dupTab, setDupTab] = useState<"email" | "phone" | "name" | "similar-email">("email");
  const [tab, setTab] = useState<"duplicates" | "formatting" | "enrichment" | "activity">("duplicates");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Map<string, { status: RowStatus; message?: string }>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingActionIds, setPendingActionIds] = useState<string[]>([]);

  // Change-log (Activity tab) state
  const [expandedLogIds, setExpandedLogIds] = useState<Set<number>>(new Set());
  const [undoConfirmEntry, setUndoConfirmEntry] = useState<ChangeLogEntry | null>(null);

  const { data, isLoading, isError, error } = useQuery<ContactQualityReport>({
    queryKey: ["/api/hubspot/sandbox-contacts-quality"],
  });

  const {
    data: changeLogData,
    isLoading: changeLogLoading,
    isFetching: changeLogFetching,
    refetch: refetchChangeLog,
    dataUpdatedAt: changeLogUpdatedAt,
  } = useQuery<{ entries: ChangeLogEntry[] }>({
    queryKey: ["/api/hubspot/sandbox-change-log"],
  });

  // Undo mutation. On success the audit cache is invalidated server-side, so
  // we also refetch the audit query so duplicates that re-emerge from a
  // reconstruct show up immediately.
  const undoMutation = useMutation({
    mutationFn: async (entryId: number) => {
      const res = await apiRequest("POST", `/api/hubspot/sandbox-change-log/${entryId}/undo`);
      return await res.json();
    },
    onSuccess: (data: { entry: ChangeLogEntry }) => {
      qc.invalidateQueries({ queryKey: ["/api/hubspot/sandbox-change-log"] });
      qc.invalidateQueries({ queryKey: ["/api/hubspot/sandbox-contacts-quality"] });
      const ur = data.entry?.undoResult;
      const msg = ur?.message ?? "Reverted.";
      toast({
        title: data.entry?.status === "undone" ? "Undo applied" : "Undo had problems",
        description: msg + (ur?.recreatedIds?.length ? ` New contact ids: ${ur.recreatedIds.join(", ")}.` : ""),
      });
      setUndoConfirmEntry(null);
    },
    onError: (e: any) => {
      toast({
        title: "Undo failed",
        description: e?.message || "HubSpot rejected the undo. The change log row is marked failed.",
        variant: "destructive",
      });
      qc.invalidateQueries({ queryKey: ["/api/hubspot/sandbox-change-log"] });
    },
  });

  // actionId → ProposedFix (for safe lookup when bulk-applying)
  const actionIndex = useMemo(() => {
    const m = new Map<string, ProposedFix>();
    if (!data) return m;
    for (const k of ["byEmail", "byPhone", "byName", "bySimilarEmail"] as const) {
      for (const g of data.duplicates[k]) m.set(g.actionId, g.fix);
    }
    for (const b of data.formatting) for (const s of b.samples) {
      if (s.actionId && s.fix) m.set(s.actionId, s.fix);
    }
    for (const b of data.enrichment) for (const s of b.samples) {
      if (s.actionId && s.fix) m.set(s.actionId, s.fix);
    }
    return m;
  }, [data]);

  const allDups = useMemo(() => {
    if (!data) return [] as DuplicateGroup[];
    if (dupTab === "email") return data.duplicates.byEmail;
    if (dupTab === "phone") return data.duplicates.byPhone;
    if (dupTab === "name") return data.duplicates.byName;
    return data.duplicates.bySimilarEmail;
  }, [data, dupTab]);

  const applyMutation = useMutation({
    mutationFn: async (vars: {
      actionIds: string[];
      overrides?: Record<
        string,
        {
          chosenProperties?: Record<string, string>;
          primaryContactId?: string;
          mergeContactIds?: string[];
        }
      >;
    }) => {
      const res = await apiRequest("POST", "/api/hubspot/sandbox-apply-fixes", vars);
      return await res.json() as { results: ApplyFixResult[]; appliedCount: number; mutatedCount: number; totalRequested: number };
    },
    onMutate: async (vars) => {
      setStatuses(prev => {
        const next = new Map(prev);
        for (const id of vars.actionIds) next.set(id, { status: "pending" });
        return next;
      });
    },
    onSuccess: async (resp, actionIds) => {
      setStatuses(prev => {
        const next = new Map(prev);
        for (const r of resp.results) next.set(r.actionId, { status: r.status, message: r.message });
        return next;
      });
      // Drop applied / partially applied IDs from selection (failed/skipped
      // stay so the user can retry). Partial keeps the badge so they see what
      // actually happened.
      setSelected(prev => {
        const next = new Set(prev);
        for (const r of resp.results) {
          if (r.status === "applied" || r.status === "partial") next.delete(r.actionId);
        }
        return next;
      });
      const failed = resp.results.filter(r => r.status === "failed").length;
      const skipped = resp.results.filter(r => r.status === "skipped").length;
      const partial = resp.results.filter(r => r.status === "partial").length;
      const descParts: string[] = [];
      if (partial > 0) descParts.push(`${partial} partial`);
      if (failed > 0) descParts.push(`${failed} failed`);
      if (skipped > 0) descParts.push(`${skipped} skipped`);
      // Add a hint when groups likely reshape under a different canonical
      // contact (HubSpot's forward-reference cleanup) so the user knows to
      // re-run the audit instead of assuming the issue vanished entirely.
      const hadSelfHeal = resp.results.some(r => /Auto-resolved|self-heal/i.test(r.message ?? ""));
      let description = descParts.length > 0 ? descParts.join(", ") + "." : undefined;
      if (partial > 0 || hadSelfHeal) {
        description = (description ? description + " " : "") + "Re-run the audit to see remaining duplicates after canonical reshape.";
      }
      toast({
        title: `${resp.appliedCount}/${resp.totalRequested} fix${resp.totalRequested === 1 ? "" : "es"} applied`,
        description,
        variant: failed > 0 ? "destructive" : "default",
      });
      // Any HubSpot mutation (full or partial) makes the audit stale AND
      // adds new entries to the change log — refresh both so the Activity
      // tab shows the just-applied fix without a manual reload.
      if (resp.mutatedCount > 0) {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["/api/hubspot/sandbox-contacts-quality"] }),
          qc.invalidateQueries({ queryKey: ["/api/hubspot/sandbox-change-log"] }),
        ]);
      }
    },
    onError: (e, vars) => {
      setStatuses(prev => {
        const next = new Map(prev);
        for (const id of vars.actionIds) {
          next.set(id, { status: "failed", message: e instanceof Error ? e.message : "Unknown error" });
        }
        return next;
      });
      toast({
        title: "Apply failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const statusOf = (id: string) => statuses.get(id) ?? { status: "idle" as RowStatus };

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startApply(ids: string[]) {
    if (ids.length === 0) return;
    const hasMerge = ids.some(id => actionIndex.get(id)?.kind === "merge");
    // Single non-merge fixes apply silently. Anything involving a merge or
    // bulk-applying multiple fixes goes through a confirmation step.
    if (hasMerge || ids.length > 1) {
      setPendingActionIds(ids);
      setConfirmOpen(true);
      return;
    }
    applyMutation.mutate({ actionIds: ids });
  }

  function applyOne(id: string) {
    startApply([id]);
  }

  // Customized merge — bypasses the bulk confirmation dialog because the
  // user already reviewed every field choice (and which contacts to include)
  // in the customize-merge dialog.
  function applyCustomizedMerge(
    actionId: string,
    chosenProperties: Record<string, string>,
    selective?: { primaryContactId: string; mergeContactIds: string[] },
  ) {
    const entry: { chosenProperties?: Record<string, string>; primaryContactId?: string; mergeContactIds?: string[] } = {};
    if (Object.keys(chosenProperties).length > 0) entry.chosenProperties = chosenProperties;
    if (selective) {
      entry.primaryContactId = selective.primaryContactId;
      entry.mergeContactIds = selective.mergeContactIds;
    }
    const overrides = Object.keys(entry).length > 0 ? { [actionId]: entry } : undefined;
    applyMutation.mutate({ actionIds: [actionId], overrides });
  }

  function applySelected() {
    const ids = Array.from(selected);
    startApply(ids);
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function selectAllAutoInTab() {
    if (!data) return;
    const ids: string[] = [];
    if (tab === "duplicates") {
      for (const g of allDups) {
        if (g.fix.kind !== "manual" && statusOf(g.actionId).status !== "applied") {
          ids.push(g.actionId);
        }
      }
    } else if (tab === "formatting") {
      for (const b of data.formatting) for (const s of b.samples) {
        if (s.actionId && s.fix && s.fix.kind !== "manual" && statusOf(s.actionId).status !== "applied") {
          ids.push(s.actionId);
        }
      }
    }
    // Enrichment is all manual — selecting "all auto-fixable" yields nothing.
    if (ids.length === 0) {
      toast({
        title: "Nothing to select",
        description: tab === "enrichment"
          ? "Enrichment opportunities are all manual — they need source data we don't have."
          : "All auto-fixable items in this tab are already applied or selected.",
      });
      return;
    }
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  const ctx: ApplyContext = { selected, toggleSelect, applyOne, applyCustomizedMerge, statusOf, applyInFlight: applyMutation.isPending };

  // After a refetch, the action index changes. Drop any selected IDs that no
  // longer exist so the user doesn't bulk-apply invisible stale items and get
  // confusing "skipped: unknown" results.
  useEffect(() => {
    if (actionIndex.size === 0) return;
    setSelected(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of Array.from(prev)) {
        if (actionIndex.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [actionIndex]);

  // Counts for the toolbar
  const selectedCount = selected.size;
  const selectedMergeCount = useMemo(() => {
    let n = 0;
    for (const id of Array.from(selected)) {
      if (actionIndex.get(id)?.kind === "merge") n++;
    }
    return n;
  }, [selected, actionIndex]);

  const pendingMergeCount = useMemo(
    () => pendingActionIds.filter(id => actionIndex.get(id)?.kind === "merge").length,
    [pendingActionIds, actionIndex],
  );

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/hubspot/sandbox-contacts-quality?refresh=1", { credentials: "include" });
      if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
      await qc.invalidateQueries({ queryKey: ["/api/hubspot/sandbox-contacts-quality"] });
      toast({ title: "Refreshed", description: "Re-analyzed every HubSpot contact." });
    } catch (e) {
      toast({
        title: "Refresh failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
    }
  }

  const portalId = data?.hubspotPortalId || "";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back-home">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
                Hubspot Data Cleanup
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Audit + fix duplicates, formatting issues, and enrichment gaps in the
                connected HubSpot portal. Pick fixes one-by-one or in bulk; approved
                changes are pushed back into HubSpot.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {data?.generatedAt && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {data.fromCache ? "Cached" : "Fresh"} · {new Date(data.generatedAt).toLocaleString()}
              </span>
            )}
            <Button onClick={handleRefresh} variant="outline" size="sm" disabled={refreshing || isLoading} data-testid="button-refresh">
              <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isError && (
          <Card className="border-destructive mb-6">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive mt-0.5" />
                <div>
                  <p className="font-medium">Couldn't load HubSpot analysis</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {error instanceof Error ? error.message : "Unknown error"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {data?.wasTruncated && (
          <Card className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20 mb-6" data-testid="banner-truncated">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Analysis is partial</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    HubSpot has more than {data.maxContactsConsidered.toLocaleString()} contacts. This analysis covers
                    the first {data.totalContacts.toLocaleString()} returned by the API. Counts shown are accurate
                    for that window only — there may be more duplicates and issues in the rest of the portal.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={<Users className="w-5 h-5" />}
            label="Total Contacts"
            value={isLoading ? null : (data?.totalContacts ?? 0).toLocaleString()}
            hint="All contacts pulled from HubSpot"
            testid="stat-total-contacts"
          />
          <StatCard
            icon={<Copy className="w-5 h-5" />}
            label="Duplicate Groups"
            value={isLoading ? null : (data?.summary.duplicateGroups ?? 0).toLocaleString()}
            hint={data ? `${data.summary.duplicateContacts.toLocaleString()} contacts involved` : undefined}
            testid="stat-duplicate-groups"
          />
          <StatCard
            icon={<AlertTriangle className="w-5 h-5" />}
            label="Formatting Issues"
            value={isLoading ? null : (data?.summary.formattingIssues ?? 0).toLocaleString()}
            hint="Across all rules below"
            testid="stat-formatting"
          />
          <StatCard
            icon={<Sparkles className="w-5 h-5" />}
            label="Enrichment Ops"
            value={isLoading ? null : (data?.summary.enrichmentOpportunities ?? 0).toLocaleString()}
            hint="Missing fields & generic data"
            testid="stat-enrichment"
          />
        </div>

        {/* Sticky review-and-apply toolbar */}
        <div
          className="sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 mb-4 bg-background/95 backdrop-blur border-b"
          data-testid="toolbar-apply"
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium" data-testid="text-selected-count">
                {selectedCount} selected
              </span>
              {selectedMergeCount > 0 && (
                <Badge variant="outline" className="gap-1 text-xs">
                  <AlertTriangle className="w-3 h-3" />
                  {selectedMergeCount} merge{selectedMergeCount === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={selectAllAutoInTab}
                disabled={!data}
                data-testid="button-select-all-auto"
              >
                Select all auto-fixable in this tab
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                disabled={selectedCount === 0}
                data-testid="button-clear-selection"
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={applySelected}
                disabled={selectedCount === 0 || applyMutation.isPending}
                data-testid="button-apply-selected"
              >
                {applyMutation.isPending
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Wand2 className="w-4 h-4 mr-2" />}
                Apply {selectedCount} selected
              </Button>
            </div>
          </div>
        </div>

        <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)} className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="duplicates" data-testid="tab-duplicates">
              <Copy className="w-4 h-4 mr-2" /> Duplicates
            </TabsTrigger>
            <TabsTrigger value="formatting" data-testid="tab-formatting">
              <AlertTriangle className="w-4 h-4 mr-2" /> Formatting
            </TabsTrigger>
            <TabsTrigger value="enrichment" data-testid="tab-enrichment">
              <Sparkles className="w-4 h-4 mr-2" /> Enrichment
            </TabsTrigger>
            <TabsTrigger value="activity" data-testid="tab-activity">
              <History className="w-4 h-4 mr-2" /> Activity
              {(changeLogData?.entries?.length ?? 0) > 0 && (
                <Badge variant="secondary" className="ml-2">{changeLogData!.entries.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="duplicates" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">De-duplication strategy</CardTitle>
                <CardDescription>
                  Groups are sorted by size (worst offenders first). Each tab shows duplicates grouped by a different
                  matching key. <strong>Email</strong> is the safest merge key. <strong>Phone</strong> can collide on
                  shared household lines. <strong>Name</strong> alone can group different people who share a name —
                  always confirm via another field before merging. <strong>Similar email</strong> catches likely
                  typos (one-character differences) that would otherwise slip past the exact-match rule. Merging
                  keeps the oldest contact (smallest HubSpot ID) and deletes the rest.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={dupTab === "email" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDupTab("email")}
                    data-testid="button-dup-email"
                  >
                    <Mail className="w-3 h-3 mr-2" />
                    By email · {data?.duplicateTotals.byEmail ?? 0}
                  </Button>
                  <Button
                    variant={dupTab === "phone" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDupTab("phone")}
                    data-testid="button-dup-phone"
                  >
                    <Phone className="w-3 h-3 mr-2" />
                    By phone · {data?.duplicateTotals.byPhone ?? 0}
                  </Button>
                  <Button
                    variant={dupTab === "name" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDupTab("name")}
                    data-testid="button-dup-name"
                  >
                    <User className="w-3 h-3 mr-2" />
                    By name · {data?.duplicateTotals.byName ?? 0}
                  </Button>
                  <Button
                    variant={dupTab === "similar-email" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDupTab("similar-email")}
                    data-testid="button-dup-similar-email"
                  >
                    <MailWarning className="w-3 h-3 mr-2" />
                    Similar email · {data?.duplicateTotals.bySimilarEmail ?? 0}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i}><CardContent className="pt-6"><Skeleton className="h-32 w-full" /></CardContent></Card>
                ))}
              </div>
            ) : allDups.length === 0 ? (
              <Card><CardContent className="pt-6 text-center text-muted-foreground">
                No duplicate groups for this key. Nice clean data!
              </CardContent></Card>
            ) : (
              <div className="space-y-3">
                {allDups.map(g => <DuplicateGroupCard key={`${g.reason}-${g.key}`} g={g} portalId={portalId} ctx={ctx} />)}
                {(() => {
                  const totalForKey = dupTab === "email" ? data!.duplicateTotals.byEmail
                    : dupTab === "phone" ? data!.duplicateTotals.byPhone
                    : dupTab === "name" ? data!.duplicateTotals.byName
                    : data!.duplicateTotals.bySimilarEmail;
                  if (totalForKey > allDups.length) {
                    return (
                      <p className="text-xs text-muted-foreground italic text-center pt-2" data-testid="text-dup-truncated">
                        Showing the {allDups.length} largest groups of {totalForKey.toLocaleString()} total. Resolve these first; refresh after merging to surface the next batch.
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            )}
          </TabsContent>

          <TabsContent value="formatting" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Formatting fixes</CardTitle>
                <CardDescription>
                  Most formatting issues can be auto-fixed (title-case names, trim
                  whitespace, normalize phone to E.164, fix typo email domains).
                  Phone shapes that can't be confidently parsed and malformed emails
                  fall back to manual review.
                </CardDescription>
              </CardHeader>
            </Card>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : (data?.formatting.length ?? 0) === 0 ? (
              <Card><CardContent className="pt-6 text-center text-muted-foreground">
                No formatting issues detected.
              </CardContent></Card>
            ) : (
              <Accordion type="multiple" className="space-y-2">
                {data!.formatting.map(b => <IssueBucketCard key={b.id} b={b} ctx={ctx} />)}
              </Accordion>
            )}
          </TabsContent>

          <TabsContent value="enrichment" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Enrichment opportunities</CardTitle>
                <CardDescription>
                  Missing fields that block segmentation, routing, or outreach. These
                  are <strong>manual-only</strong> — we don't have source data to fill
                  them automatically. Use the "Open" link to fix in HubSpot directly,
                  or pipe through an enrichment integration.
                </CardDescription>
              </CardHeader>
            </Card>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : (data?.enrichment.length ?? 0) === 0 ? (
              <Card><CardContent className="pt-6 text-center text-muted-foreground">
                No enrichment opportunities detected.
              </CardContent></Card>
            ) : (
              <Accordion type="multiple" className="space-y-2">
                {data!.enrichment.map(b => <IssueBucketCard key={b.id} b={b} ctx={ctx} />)}
              </Accordion>
            )}
          </TabsContent>

          <TabsContent value="activity" className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-muted-foreground" data-testid="text-activity-meta">
                {changeLogData?.entries.length ?? 0} entr{(changeLogData?.entries.length ?? 0) === 1 ? "y" : "ies"}
                {changeLogUpdatedAt > 0 && (
                  <> · last refreshed {new Date(changeLogUpdatedAt).toLocaleTimeString()}</>
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchChangeLog()}
                disabled={changeLogFetching}
                data-testid="button-refresh-activity"
              >
                {changeLogFetching
                  ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  : <RefreshCw className="w-3 h-3 mr-1" />}
                Refresh
              </Button>
            </div>
            <ChangeLogTab
              entries={changeLogData?.entries ?? []}
              isLoading={changeLogLoading}
              expandedIds={expandedLogIds}
              onToggleExpand={(id) => {
                setExpandedLogIds(prev => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                });
              }}
              onUndoClick={setUndoConfirmEntry}
              undoingId={undoMutation.isPending ? undoMutation.variables ?? null : null}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Undo confirmation — extra-warned for merges since they can't be
          truly un-merged (HubSpot has no unmerge API; we reconstruct as new
          contacts with no engagement history). */}
      <AlertDialog open={!!undoConfirmEntry} onOpenChange={(o) => !o && setUndoConfirmEntry(null)}>
        <AlertDialogContent data-testid="dialog-confirm-undo">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Undo this {undoConfirmEntry?.kind === "merge" ? "merge" : "property change"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <div><strong>{undoConfirmEntry?.summary}</strong></div>
                {undoConfirmEntry?.kind === "merge" ? (
                  <>
                    <div className="text-amber-700 dark:text-amber-400">
                      HubSpot has no unmerge API. We will <strong>recreate</strong> the merged
                      contacts as <strong>brand-new HubSpot records</strong> using the property
                      snapshot taken before the merge. Engagement history (calls, notes,
                      emails, deal associations) <strong>cannot be restored</strong> — it stays
                      on the primary contact.
                    </div>
                    {undoConfirmEntry?.detail?.snapshotError && (
                      <div className="text-destructive">
                        Snapshot error at apply time: {undoConfirmEntry.detail.snapshotError}.
                        Undo will likely fail.
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    The original property values will be PATCHed back into HubSpot. This is a
                    true revert.
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-undo-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-undo-confirm"
              onClick={() => undoConfirmEntry && undoMutation.mutate(undoConfirmEntry.id)}
            >
              {undoConfirmEntry?.kind === "merge" ? "Reconstruct contacts" : "Revert change"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="dialog-confirm-apply">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply {pendingActionIds.length} fix{pendingActionIds.length === 1 ? "" : "es"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMergeCount > 0 ? (
                <>
                  This will run <strong>{pendingMergeCount} merge{pendingMergeCount === 1 ? "" : "s"}</strong> in
                  HubSpot. Each merge keeps the oldest contact and deletes the rest. You can revert from
                  the <strong>Activity</strong> tab — note that merge undo is reconstruct-only (new contact ids,
                  no engagement history). The remaining {pendingActionIds.length - pendingMergeCount} fix{pendingActionIds.length - pendingMergeCount === 1 ? "" : "es"} are property updates and revert cleanly.
                </>
              ) : (
                <>This will PATCH {pendingActionIds.length} contact{pendingActionIds.length === 1 ? "" : "s"} in HubSpot. You can undo individually in HubSpot's contact history if needed.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                applyMutation.mutate({ actionIds: pendingActionIds });
                setPendingActionIds([]);
              }}
              data-testid="button-confirm-apply"
            >
              Apply {pendingActionIds.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
