// HubSpot SANDBOX contact data-quality analysis.
//
// Mirrors hubspot-analysis.ts but points at a SECOND, isolated HubSpot
// instance via its own API key (HUBSPOT_SANDBOX_API_KEY) and its own portal
// id (HUBSPOT_SANDBOX_PORTAL_ID, used only to build "Open in HubSpot" links).
// Kept as a true duplicate (rather than a refactor of the original) so the
// existing HubSpot Contact Quality page stays bit-for-bit identical.
//
// Pages every contact, then derives three buckets of cleanup signals:
//   1. Duplicate groups (by email, by normalized phone, by name + company).
//   2. Formatting issues (capitalization, phone shape, email typos, etc).
//   3. Enrichment opportunities (missing core fields, generic mailboxes, etc).
//
// All work is read-only. Results are returned to the client which renders the
// findings; no data is mutated in HubSpot.

const HUBSPOT_API_BASE = "https://api.hubapi.com";
// Empty string is acceptable — only used to build deep links into HubSpot. If
// not configured, the link will be malformed but the audit data is unaffected.
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_SANDBOX_PORTAL_ID || "";

function getHubSpotToken(): string {
  const key = process.env.HUBSPOT_SANDBOX_API_KEY;
  if (!key) throw new Error("HUBSPOT_SANDBOX_API_KEY is not configured");
  return key;
}

export interface HubSpotContact {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  mobilePhone: string | null;
  company: string | null;
  jobTitle: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  lifecycleStage: string | null;
  leadStatus: string | null;
  ownerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface HubSpotContactRaw {
  id: string;
  properties: Record<string, string | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
}

interface HubSpotContactsPage {
  results: HubSpotContactRaw[];
  paging?: { next?: { after: string } };
}

const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "mobilephone",
  "company",
  "jobtitle",
  "city",
  "state",
  "zip",
  "country",
  "lifecyclestage",
  "hs_lead_status",
  "hubspot_owner_id",
  // Surfaces historical merge VIDs on the canonical record. We use this to
  // identify and DROP non-canonical "ghost" contacts before duplicate
  // detection runs — otherwise they re-appear as fake dups even though
  // HubSpot will refuse to merge them ("Only canonical objects can be merged").
  "hs_calculated_merged_vids",
];

function strOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed.length === 0 ? null : trimmed;
}

function mapContact(raw: HubSpotContactRaw): HubSpotContact {
  const p = raw.properties || {};
  return {
    id: raw.id,
    email: strOrNull(p.email),
    firstName: strOrNull(p.firstname),
    lastName: strOrNull(p.lastname),
    phone: strOrNull(p.phone),
    mobilePhone: strOrNull(p.mobilephone),
    company: strOrNull(p.company),
    jobTitle: strOrNull(p.jobtitle),
    city: strOrNull(p.city),
    state: strOrNull(p.state),
    zip: strOrNull(p.zip),
    country: strOrNull(p.country),
    lifecycleStage: strOrNull(p.lifecyclestage),
    leadStatus: strOrNull(p.hs_lead_status),
    ownerId: strOrNull(p.hubspot_owner_id),
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

/** Parse `hs_calculated_merged_vids` into a clean list of stringified VIDs.
 *  HubSpot returns this as `vid:mergedAtMs[;vid:mergedAtMs...]` — semicolon-
 *  separated pairs where the first half is the absorbed contact's VID and
 *  the second half is the merge timestamp. We strip the timestamp half and
 *  keep only the leading numeric id. Empty / malformed inputs return []. */
function parseMergedVids(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const chunk of String(raw).split(/[;,\s]+/)) {
    const head = chunk.trim().split(":")[0]?.trim() ?? "";
    if (/^\d+$/.test(head)) out.push(head);
  }
  return out;
}

export interface FetchAllResult {
  contacts: HubSpotContact[];
  /** True if we hit the page cap and there are more contacts in HubSpot we
   *  did not pull. The UI surfaces a warning when this is true so users know
   *  the analysis is partial. */
  wasTruncated: boolean;
  /** Hard cap on contacts pulled (page count × page size). */
  maxContactsConsidered: number;
}

/**
 * Page every contact in the HubSpot account. Hard-cap at 200 pages × 100 =
 * 20,000 contacts to stay polite under HubSpot's daily limits and avoid
 * unbounded memory if the portal grows.
 */
export async function fetchAllHubSpotContacts(): Promise<FetchAllResult> {
  const token = getHubSpotToken();
  const out: HubSpotContact[] = [];
  const limit = 100;
  const maxPages = 200;
  let after: string | undefined = undefined;
  let wasTruncated = false;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("properties", CONTACT_PROPERTIES.join(","));
    if (after) params.set("after", after);
    const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?${params.toString()}`;

    let res: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (res.status !== 429) break;
      // HubSpot's 429 sometimes returns Retry-After in seconds; default to 2s.
      const retry = parseInt(res.headers.get("retry-after") || "2", 10) || 2;
      await new Promise(r => setTimeout(r, retry * 1000));
    }
    if (!res || !res.ok) {
      const txt = res ? await res.text().catch(() => "") : "";
      throw new Error(`HubSpot contacts fetch failed: ${res?.status} ${txt.substring(0, 200)}`);
    }
    const data = (await res.json()) as HubSpotContactsPage;
    for (const c of data.results || []) {
      // Track historical-merge pointers BEFORE we drop the raw payload so
      // the post-pass below can filter ghost (non-canonical) contacts.
      const mergedFrom = parseMergedVids(c.properties?.hs_calculated_merged_vids);
      const mapped = mapContact(c);
      // Stash on the mapped object via a private field — we strip it after
      // filtering so downstream consumers see the regular shape.
      (mapped as HubSpotContact & { _mergedFrom?: string[] })._mergedFrom = mergedFrom;
      out.push(mapped);
    }
    after = data.paging?.next?.after;
    if (!after) break;
    // If we exit via the loop bound (maxPages reached) AND HubSpot still has
    // a `next` cursor, we know we truncated.
    if (page === maxPages - 1 && after) wasTruncated = true;
  }

  // Self-clean: any contact ID that appears in another contact's
  // hs_calculated_merged_vids has already been merged away — keeping it would
  // produce zombie duplicate groups whose merge will fail with "Only canonical
  // objects can be merged". Strip those out + clear the temporary field.
  const mergedAway = new Set<string>();
  for (const c of out) {
    const ext = c as HubSpotContact & { _mergedFrom?: string[] };
    if (ext._mergedFrom) {
      for (const vid of ext._mergedFrom) mergedAway.add(vid);
    }
  }
  const filtered = out.filter(c => !mergedAway.has(c.id));
  for (const c of filtered) {
    delete (c as HubSpotContact & { _mergedFrom?: string[] })._mergedFrom;
  }
  if (mergedAway.size > 0) {
    console.log(`[HubSpot Sandbox] Filtered ${mergedAway.size} non-canonical (already-merged) contacts from audit.`);
  }
  return { contacts: filtered, wasTruncated, maxContactsConsidered: maxPages * limit };
}

// ──────────────────────────────────────────────────────────────────────
// Normalization helpers used for duplicate detection.

function normEmail(e: string | null): string | null {
  if (!e) return null;
  const t = e.trim().toLowerCase();
  return t.includes("@") ? t : null;
}

/** Strip everything but digits, then drop a leading "1" so US numbers
 *  collide regardless of country-code formatting. Returns null if < 10 digits. */
function normPhone(p: string | null): string | null {
  if (!p) return null;
  let digits = p.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length >= 10 ? digits : null;
}

function normName(s: string | null): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns true iff two strings are within Levenshtein distance 1 (single
 * substitution, insertion, or deletion). Returns false for equal strings —
 * we only care about *near* matches, not exact ones (those are caught by the
 * by-email rule). Linear time; no DP table allocation.
 */
function editDistanceLE1(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < t.length) {
    if (s[i] === t[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (s.length === t.length) {
      // Substitution — advance both.
      i++;
      j++;
    } else {
      // Insertion in t — advance only t.
      j++;
    }
  }
  // Trailing tail in t counts as additional edits.
  edits += t.length - j;
  return edits === 1;
}

// ──────────────────────────────────────────────────────────────────────
// Output shape returned to the UI.

export interface DuplicateGroup {
  key: string;
  reason: "email" | "phone" | "name" | "similar-email";
  contactIds: string[];
  sample: { id: string; name: string; email: string | null; phone: string | null; company: string | null }[];
  count: number;
  /** Stable id for the apply endpoint. Derived from primary + sorted ids. */
  actionId: string;
  /** Always a "merge" — primary is the oldest (smallest numeric id). */
  fix: ProposedFix;
}

export interface ContactSample {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  hubspotUrl: string;
  detail?: string;
  /** Present for formatting/enrichment matches that have a proposed fix. */
  actionId?: string;
  fix?: ProposedFix;
}

export interface IssueBucket {
  id: string;
  label: string;
  description: string;
  count: number;
  samples: ContactSample[];
}

/** Discriminated union of fix proposals attached to each issue. */
export type ProposedFix =
  | {
      kind: "merge";
      primaryContactId: string;
      mergeContactIds: string[];
      description: string;
    }
  | {
      kind: "update";
      contactId: string;
      /** Property values to PATCH into HubSpot. */
      properties: Record<string, string>;
      /** Human-readable preview rows for the UI. */
      preview: { property: string; from: string | null; to: string }[];
      description: string;
    }
  | {
      kind: "manual";
      contactId: string;
      description: string;
    };

export interface ApplyFixResult {
  actionId: string;
  /**
   * - `applied`: every part of the fix succeeded.
   * - `partial`: a multi-step merge succeeded for some pairs but not others.
   *    HubSpot data was mutated; the caller MUST treat this like `applied`
   *    for cache invalidation purposes.
   * - `failed`: nothing succeeded.
   * - `skipped`: manual-only or already in progress; HubSpot was NOT touched.
   */
  status: "applied" | "partial" | "failed" | "skipped";
  message?: string;
  /**
   * For merge fixes: the contact ids that were ACTUALLY merged into (and thus
   * deleted from) HubSpot. May differ from the requested mergeContactIds in
   * two cases:
   *   • Partial: only the pairs that succeeded are listed.
   *   • Self-heal: when the requested secondary was a forward-reference ghost
   *     and we retried with the canonical id, the canonical id is listed
   *     instead of the original ghost.
   * Used by the change log so undo only tries to reconstruct contacts that
   * were truly removed.
   */
  mergedSecondaryIds?: string[];
}

export interface ContactQualityReport {
  generatedAt: string;
  totalContacts: number;
  /** True if HubSpot has more contacts than we pulled (page cap hit). The UI
   *  shows a warning banner and the analysis should be treated as partial. */
  wasTruncated: boolean;
  /** Maximum contacts the analyzer is willing to consider in a single run. */
  maxContactsConsidered: number;
  hubspotPortalId: string;
  summary: {
    /** True total across all keys, NOT capped to display limits. */
    duplicateGroups: number;
    /** Distinct contact IDs that appear in any duplicate group, NOT capped. */
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
  /** Total counts per key (NOT capped) so the UI can show "showing 100 of N". */
  duplicateTotals: {
    byEmail: number;
    byPhone: number;
    byName: number;
    bySimilarEmail: number;
  };
  formatting: IssueBucket[];
  enrichment: IssueBucket[];
}

function displayName(c: HubSpotContact): string {
  const fn = c.firstName || "";
  const ln = c.lastName || "";
  const full = `${fn} ${ln}`.trim();
  if (full) return full;
  if (c.email) return c.email;
  if (c.company) return c.company;
  return `Contact ${c.id}`;
}

function hubspotUrl(contactId: string): string {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/contact/${contactId}`;
}

function toSample(c: HubSpotContact, detail?: string, fix?: ProposedFix, scope?: string): ContactSample {
  return {
    id: c.id,
    name: displayName(c),
    email: c.email,
    phone: c.phone || c.mobilePhone || null,
    company: c.company,
    hubspotUrl: hubspotUrl(c.id),
    detail,
    fix,
    actionId: fix ? actionIdForFix(fix, scope) : undefined,
  };
}

const SAMPLE_LIMIT = 50;
const DUP_GROUP_LIMIT = 100;

// ──────────────────────────────────────────────────────────────────────
// Heuristics — kept as small, named helpers so each bucket is auditable.

function isAllLower(s: string): boolean {
  return /[a-z]/.test(s) && s === s.toLowerCase();
}
function isAllUpper(s: string): boolean {
  return /[A-Z]/.test(s) && s === s.toUpperCase() && s.length > 1;
}
function hasLeadingTrailingWhitespace(orig: string | null, normalized: string | null): boolean {
  if (orig == null || normalized == null) return false;
  return orig !== orig.trim();
}

/** Typo domain → canonical domain. The keys form the set we flag, and the
 *  values let us propose a concrete fix (e.g. gmail.con → gmail.com). */
const EMAIL_TYPO_FIX_MAP: Record<string, string> = {
  "gmail.con": "gmail.com", "gmial.com": "gmail.com", "gmai.com": "gmail.com",
  "gmail.co": "gmail.com", "gmaill.com": "gmail.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com", "yahoo.co": "yahoo.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "hotmail.con": "hotmail.com", "hotmial.co": "hotmail.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com",
  "iclou.com": "icloud.com", "iclould.com": "icloud.com",
};
const EMAIL_TYPO_DOMAINS = new Set(Object.keys(EMAIL_TYPO_FIX_MAP));

const GENERIC_EMAIL_LOCAL = new Set([
  "info", "sales", "admin", "office", "support", "contact", "billing",
  "accounts", "accounting", "service", "help", "hello", "team", "noreply",
  "no-reply", "donotreply",
]);

function emailLocalPart(e: string): string { return e.split("@")[0] || ""; }
function emailDomain(e: string): string { return (e.split("@")[1] || "").toLowerCase(); }

function isLikelyTypoEmail(e: string): boolean {
  const dom = emailDomain(e);
  return EMAIL_TYPO_DOMAINS.has(dom);
}

function isGenericEmail(e: string): boolean {
  const local = emailLocalPart(e).toLowerCase();
  return GENERIC_EMAIL_LOCAL.has(local);
}

// ──────────────────────────────────────────────────────────────────────
// Fix-proposal helpers.

/** Title-case a name: handles spaces and hyphens (e.g. "smith-jones"). */
function titleCase(s: string): string {
  return s.split(/(\s+|-)/).map(part => {
    if (part.length === 0) return part;
    if (/^\s+$/.test(part) || part === "-") return part;
    return part[0].toUpperCase() + part.slice(1).toLowerCase();
  }).join("");
}

/** Normalize a phone to E.164 (+1XXXXXXXXXX) ONLY if confidently parseable
 *  as a US number. Returns null when the format is too ambiguous to auto-fix. */
function normalizePhoneE164(raw: string): string | null {
  if (/[a-zA-Z]/.test(raw)) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
  return null;
}

/** Replace the domain of an email address. */
function replaceEmailDomain(email: string, newDomain: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  return email.slice(0, at + 1) + newDomain;
}

/** Stable ID for an action — survives cache rebuilds. `scope` distinguishes
 *  the same contact across different formatting/enrichment buckets. */
function actionIdForFix(fix: ProposedFix, scope?: string): string {
  if (fix.kind === "merge") {
    const sorted = [...fix.mergeContactIds].sort().join(",");
    return `merge:${fix.primaryContactId}:${sorted}`;
  }
  if (fix.kind === "update") {
    const key = scope || Object.keys(fix.properties).sort().join("+");
    return `update:${fix.contactId}:${key}`;
  }
  return `manual:${fix.contactId}:${scope || "general"}`;
}

// ──────────────────────────────────────────────────────────────────────
// Main analyzer.

export function analyzeContacts(
  contacts: HubSpotContact[],
  meta: { wasTruncated: boolean; maxContactsConsidered: number } = { wasTruncated: false, maxContactsConsidered: contacts.length },
): ContactQualityReport {
  // ── Duplicates ─────────────────────────────────────────────────────
  // Sandbox rules (intentionally looser than the production audit):
  //   • by email          — exact normalized email match
  //   • by phone          — normalized phone match (work or mobile)
  //   • by name           — first + last name match (company is NOT required)
  //   • by similar email  — emails within Levenshtein distance 1, e.g. typos
  const byEmailMap = new Map<string, HubSpotContact[]>();
  const byPhoneMap = new Map<string, HubSpotContact[]>();
  const byNameMap = new Map<string, HubSpotContact[]>();

  for (const c of contacts) {
    const e = normEmail(c.email);
    if (e) {
      const arr = byEmailMap.get(e) || [];
      arr.push(c);
      byEmailMap.set(e, arr);
    }
    const phones = [normPhone(c.phone), normPhone(c.mobilePhone)].filter((x): x is string => !!x);
    const seen = new Set<string>();
    for (const p of phones) {
      if (seen.has(p)) continue;
      seen.add(p);
      const arr = byPhoneMap.get(p) || [];
      arr.push(c);
      byPhoneMap.set(p, arr);
    }
    const fn = normName(c.firstName);
    const ln = normName(c.lastName);
    if (fn && ln) {
      const key = `${fn} ${ln}`;
      const arr = byNameMap.get(key) || [];
      arr.push(c);
      byNameMap.set(key, arr);
    }
  }

  // Similar-email detection (likely typos). For each pair of distinct emails
  // whose edit distance is exactly 1, union their contacts into a group.
  // We bucket by length so we only compare emails that could possibly differ
  // by a single character (same length = substitution, ±1 length = ins/del).
  const bySimilarEmailMap = (() => {
    const emailToContacts = new Map<string, HubSpotContact[]>();
    for (const c of contacts) {
      const e = normEmail(c.email);
      if (!e) continue;
      const arr = emailToContacts.get(e) || [];
      arr.push(c);
      emailToContacts.set(e, arr);
    }
    const distinctEmails = Array.from(emailToContacts.keys());
    const byLen = new Map<number, string[]>();
    for (const e of distinctEmails) {
      const arr = byLen.get(e.length) || [];
      arr.push(e);
      byLen.set(e.length, arr);
    }
    // Union–find on email strings.
    const parent = new Map<string, string>();
    for (const e of distinctEmails) parent.set(e, e);
    const find = (x: string): string => {
      let cur = x;
      while (parent.get(cur)! !== cur) cur = parent.get(cur)!;
      return cur;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const lengths = Array.from(byLen.keys()).sort((a, b) => a - b);
    for (const L of lengths) {
      const sameLen = byLen.get(L) || [];
      const nextLen = byLen.get(L + 1) || [];
      // Substitutions (within same length).
      for (let i = 0; i < sameLen.length; i++) {
        const a = sameLen[i];
        for (let j = i + 1; j < sameLen.length; j++) {
          if (editDistanceLE1(a, sameLen[j])) union(a, sameLen[j]);
        }
      }
      // Insertion / deletion (length ±1).
      for (const a of sameLen) {
        for (const b of nextLen) {
          if (editDistanceLE1(a, b)) union(a, b);
        }
      }
    }
    // Bucket emails by their root, then materialize into contact groups.
    const emailsByRoot = new Map<string, string[]>();
    for (const e of distinctEmails) {
      const r = find(e);
      const arr = emailsByRoot.get(r) || [];
      arr.push(e);
      emailsByRoot.set(r, arr);
    }
    const groups = new Map<string, HubSpotContact[]>();
    for (const emails of Array.from(emailsByRoot.values())) {
      if (emails.length < 2) continue; // not a similarity cluster
      const sorted = emails.slice().sort();
      const key = sorted.join(" ↔ ");
      const contactList: HubSpotContact[] = [];
      for (const e of sorted) contactList.push(...(emailToContacts.get(e) || []));
      groups.set(key, contactList);
    }
    return groups;
  })();

  // Build groups in two stages so summary metrics reflect the FULL dataset
  // rather than the display-capped slice.
  function buildAllGroups(map: Map<string, HubSpotContact[]>, reason: DuplicateGroup["reason"]): DuplicateGroup[] {
    const groups: DuplicateGroup[] = [];
    for (const [key, arr] of Array.from(map.entries())) {
      if (arr.length < 2) continue;
      // Primary = oldest contact = smallest numeric id (HubSpot ids are
      // roughly monotonic by creation time).
      const sortedById = [...arr].sort((a, b) => Number(a.id) - Number(b.id));
      const primary = sortedById[0];
      const secondaries = sortedById.slice(1);
      const fix: ProposedFix = {
        kind: "merge",
        primaryContactId: primary.id,
        mergeContactIds: secondaries.map(c => c.id),
        description: `Merge ${secondaries.length} duplicate${secondaries.length === 1 ? "" : "s"} into contact ${primary.id} (${displayName(primary)}). Secondaries will be deleted.`,
      };
      groups.push({
        key,
        reason,
        contactIds: arr.map((c: HubSpotContact) => c.id),
        sample: arr.slice(0, 5).map((c: HubSpotContact) => ({
          id: c.id,
          name: displayName(c),
          email: c.email,
          phone: c.phone || c.mobilePhone || null,
          company: c.company,
        })),
        count: arr.length,
        actionId: actionIdForFix(fix),
        fix,
      });
    }
    groups.sort((a, b) => b.count - a.count);
    return groups;
  }

  const allDupByEmail = buildAllGroups(byEmailMap, "email");
  const allDupByPhone = buildAllGroups(byPhoneMap, "phone");
  const allDupByName = buildAllGroups(byNameMap, "name");
  const allDupBySimilarEmail = buildAllGroups(bySimilarEmailMap, "similar-email");

  // Summary uses the full set of groups (not the display cap).
  const distinctDuplicateContactIds = new Set<string>();
  for (const g of [...allDupByEmail, ...allDupByPhone, ...allDupByName, ...allDupBySimilarEmail]) {
    for (const id of g.contactIds) distinctDuplicateContactIds.add(id);
  }

  // Display arrays are capped to keep the JSON payload reasonable.
  const dupByEmail = allDupByEmail.slice(0, DUP_GROUP_LIMIT);
  const dupByPhone = allDupByPhone.slice(0, DUP_GROUP_LIMIT);
  const dupByName = allDupByName.slice(0, DUP_GROUP_LIMIT);
  const dupBySimilarEmail = allDupBySimilarEmail.slice(0, DUP_GROUP_LIMIT);

  // ── Formatting issues ──────────────────────────────────────────────
  type Bucket = { id: string; label: string; description: string; matches: ContactSample[] };
  function bucket(id: string, label: string, description: string): Bucket {
    return { id, label, description, matches: [] };
  }

  const fmtNameCase = bucket(
    "name-case",
    "Name not properly capitalized",
    "First or last name is all lowercase or all uppercase. HubSpot displays names as-entered, which makes outreach feel sloppy.",
  );
  const fmtNameWhitespace = bucket(
    "name-whitespace",
    "Name has leading or trailing whitespace",
    "Whitespace causes silent dedupe misses and weird spacing in merge fields.",
  );
  const fmtPhoneShape = bucket(
    "phone-shape",
    "Phone number isn't a valid 10-digit US format",
    "Phone has fewer than 10 digits, contains letters, or has more than 11 digits. Standardize to E.164 (e.g. +14045551234) for reliable dialing. NOTE: this rule assumes US numbers — international contacts may be flagged falsely.",
  );
  const fmtEmailWhitespace = bucket(
    "email-whitespace",
    "Email has whitespace or stray characters",
    "Causes silent delivery failures and breaks dedupe.",
  );
  const fmtEmailTypo = bucket(
    "email-typo",
    "Email has a likely-typo domain",
    "Domains like gmail.con, yahooo.com, hotmial.com indicate fat-fingered entry. Bouncing emails hurt sender reputation.",
  );
  const fmtJobTitleCase = bucket(
    "jobtitle-case",
    "Job title is all caps or all lowercase",
    "Hard to read in proposals and email signatures. Common acronyms (CEO, CFO, COO, CTO, CIO, VP, HOA, GM, IT, HR) are excluded so legitimately-uppercase titles aren't flagged.",
  );

  // Acronyms that legitimately appear all-uppercase as a job title. Anything
  // matching these (case-insensitive, post-trim) is exempted from the
  // jobtitle-case formatting rule.
  const JOB_TITLE_ACRONYMS = new Set([
    "ceo", "cfo", "coo", "cto", "cio", "cmo", "cso", "vp", "evp", "svp",
    "hoa", "gm", "it", "hr", "pr", "qa", "qc", "ux", "ui",
  ]);
  function isAcronymJobTitle(t: string): boolean {
    const norm = t.trim().toLowerCase();
    return JOB_TITLE_ACRONYMS.has(norm);
  }

  // ── Enrichment opportunities ───────────────────────────────────────
  const enrNoContactInfo = bucket(
    "no-contact-info",
    "No email AND no phone",
    "Contact has neither an email nor a phone — effectively unreachable. Candidates for archiving.",
  );
  const enrMissingEmail = bucket(
    "missing-email",
    "Has phone but no email",
    "Add an email to enable nurture campaigns and proposals.",
  );
  const enrMissingPhone = bucket(
    "missing-phone",
    "Has email but no phone",
    "Add a phone to enable AI calling, SMS outreach, and faster outbound.",
  );
  const enrMissingCompany = bucket(
    "missing-company",
    "No company set",
    "Without a company, contacts can't be grouped or routed to account managers.",
  );
  const enrMissingName = bucket(
    "missing-name",
    "Missing first or last name",
    "Personalized greetings fall back to generic openers.",
  );
  const enrMissingLifecycle = bucket(
    "missing-lifecycle",
    "No lifecycle stage",
    "Reports and routing rely on lifecycle stage. Default unknown contacts to 'Lead'.",
  );
  const enrMissingOwner = bucket(
    "missing-owner",
    "No HubSpot owner assigned",
    "Unowned contacts get no follow-up and no accountability.",
  );
  const enrGenericEmail = bucket(
    "generic-email",
    "Generic mailbox email (info@, sales@, etc)",
    "Generic mailboxes lower deliverability and aren't tied to a real human. Try to capture a personal contact.",
  );

  function manualFix(contactId: string, description: string): ProposedFix {
    return { kind: "manual", contactId, description };
  }

  for (const c of contacts) {
    const fnRaw = c.firstName || "";
    const lnRaw = c.lastName || "";
    // Treat firstname + lastname as a single fix so a contact like
    // "abundio espinoza" gets BOTH names title-cased in one PATCH instead of
    // only the first one. We collect every name field that needs casing,
    // build one update with all the affected properties, and surface a
    // detail string that mentions every changed field.
    const nameProps: Record<string, string> = {};
    const namePreview: { property: string; from: string | null; to: string }[] = [];
    const nameDetailParts: string[] = [];
    if (fnRaw && (isAllLower(fnRaw) || isAllUpper(fnRaw))) {
      const titled = titleCase(fnRaw);
      nameProps.firstname = titled;
      namePreview.push({ property: "firstname", from: fnRaw, to: titled });
      nameDetailParts.push(`firstname: "${fnRaw}"`);
    }
    if (lnRaw && (isAllLower(lnRaw) || isAllUpper(lnRaw))) {
      const titled = titleCase(lnRaw);
      nameProps.lastname = titled;
      namePreview.push({ property: "lastname", from: lnRaw, to: titled });
      nameDetailParts.push(`lastname: "${lnRaw}"`);
    }
    if (namePreview.length > 0 && fmtNameCase.matches.length < SAMPLE_LIMIT) {
      const fields = namePreview.map(p => p.property).join(" + ");
      const fix: ProposedFix = {
        kind: "update",
        contactId: c.id,
        properties: nameProps,
        preview: namePreview,
        description: `Title-case ${fields}.`,
      };
      fmtNameCase.matches.push(toSample(c, nameDetailParts.join(", "), fix, "name-case"));
    }
    if (hasLeadingTrailingWhitespace(c.firstName, c.firstName?.trim() || null)
      || hasLeadingTrailingWhitespace(c.lastName, c.lastName?.trim() || null)) {
      if (fmtNameWhitespace.matches.length < SAMPLE_LIMIT) {
        const props: Record<string, string> = {};
        const preview: { property: string; from: string | null; to: string }[] = [];
        if (c.firstName && c.firstName !== c.firstName.trim()) {
          const t = c.firstName.trim();
          props.firstname = t;
          preview.push({ property: "firstname", from: c.firstName, to: t });
        }
        if (c.lastName && c.lastName !== c.lastName.trim()) {
          const t = c.lastName.trim();
          props.lastname = t;
          preview.push({ property: "lastname", from: c.lastName, to: t });
        }
        const fix: ProposedFix = {
          kind: "update",
          contactId: c.id,
          properties: props,
          preview,
          description: `Trim whitespace from ${preview.map(p => p.property).join(" + ")}.`,
        };
        fmtNameWhitespace.matches.push(toSample(c, undefined, fix, "name-whitespace"));
      }
    }

    const rawPhone = c.phone || c.mobilePhone;
    if (rawPhone) {
      const digits = rawPhone.replace(/\D+/g, "");
      const hasLetters = /[a-zA-Z]/.test(rawPhone);
      const tooShort = digits.length < 10;
      const tooLong = digits.length > 11;
      if (hasLetters || tooShort || tooLong) {
        if (fmtPhoneShape.matches.length < SAMPLE_LIMIT) {
          const e164 = normalizePhoneE164(rawPhone);
          // Update whichever phone field actually holds the bad value so we
          // don't accidentally overwrite a good fallback in the other field.
          const badField = c.phone === rawPhone ? "phone" : "mobilephone";
          const fix: ProposedFix = e164
            ? {
                kind: "update",
                contactId: c.id,
                properties: { [badField]: e164 },
                preview: [{ property: badField, from: rawPhone, to: e164 }],
                description: `Normalize ${badField} "${rawPhone}" → "${e164}" (E.164).`,
              }
            : manualFix(c.id, `Phone "${rawPhone}" can't be confidently parsed as a US number — review manually.`);
          fmtPhoneShape.matches.push(toSample(c, `phone: "${rawPhone}"`, fix, "phone-shape"));
        }
      }
    }

    if (c.email) {
      const trimmed = c.email.trim();
      const hasInternalSpace = /\s/.test(trimmed);
      const looksMalformed = !trimmed.includes("@") || trimmed.split("@").length !== 2;
      if (trimmed !== c.email || hasInternalSpace || looksMalformed) {
        if (fmtEmailWhitespace.matches.length < SAMPLE_LIMIT) {
          const cleaned = trimmed.replace(/\s+/g, "");
          const cleanedLooksValid = cleaned.includes("@") && cleaned.split("@").length === 2;
          const fix: ProposedFix = (!looksMalformed && cleanedLooksValid)
            ? {
                kind: "update",
                contactId: c.id,
                properties: { email: cleaned },
                preview: [{ property: "email", from: c.email, to: cleaned }],
                description: `Strip whitespace from email → "${cleaned}".`,
              }
            : manualFix(c.id, `Email "${c.email}" is malformed (missing or extra @) — fix manually.`);
          fmtEmailWhitespace.matches.push(toSample(c, `email: "${c.email}"`, fix, "email-whitespace"));
        }
      }
      const lower = trimmed.toLowerCase();
      if (isLikelyTypoEmail(lower)) {
        if (fmtEmailTypo.matches.length < SAMPLE_LIMIT) {
          const dom = emailDomain(lower);
          const newDom = EMAIL_TYPO_FIX_MAP[dom];
          const newEmail = replaceEmailDomain(lower, newDom);
          const fix: ProposedFix = {
            kind: "update",
            contactId: c.id,
            properties: { email: newEmail },
            preview: [{ property: "email", from: c.email, to: newEmail }],
            description: `Fix typo domain "${dom}" → "${newDom}".`,
          };
          fmtEmailTypo.matches.push(toSample(c, `domain: "${dom}"`, fix, "email-typo"));
        }
      }
      if (isGenericEmail(lower)) {
        if (enrGenericEmail.matches.length < SAMPLE_LIMIT) {
          enrGenericEmail.matches.push(toSample(c, `email: "${c.email}"`,
            manualFix(c.id, "Generic mailbox — capture a personal contact instead."),
            "generic-email"));
        }
      }
    }

    if (c.jobTitle && (isAllLower(c.jobTitle) || isAllUpper(c.jobTitle)) && !isAcronymJobTitle(c.jobTitle)) {
      if (fmtJobTitleCase.matches.length < SAMPLE_LIMIT) {
        const titled = titleCase(c.jobTitle);
        const fix: ProposedFix = {
          kind: "update",
          contactId: c.id,
          properties: { jobtitle: titled },
          preview: [{ property: "jobtitle", from: c.jobTitle, to: titled }],
          description: `Title-case job title "${c.jobTitle}" → "${titled}".`,
        };
        fmtJobTitleCase.matches.push(toSample(c, `title: "${c.jobTitle}"`, fix, "jobtitle-case"));
      }
    }

    const hasEmail = !!normEmail(c.email);
    const hasPhone = !!(normPhone(c.phone) || normPhone(c.mobilePhone));
    if (!hasEmail && !hasPhone) {
      if (enrNoContactInfo.matches.length < SAMPLE_LIMIT) {
        enrNoContactInfo.matches.push(toSample(c, undefined,
          manualFix(c.id, "No email and no phone — needs a real contact path or archive."),
          "no-contact-info"));
      }
    } else if (hasPhone && !hasEmail) {
      if (enrMissingEmail.matches.length < SAMPLE_LIMIT) {
        enrMissingEmail.matches.push(toSample(c, undefined,
          manualFix(c.id, "Add an email address."),
          "missing-email"));
      }
    } else if (hasEmail && !hasPhone) {
      if (enrMissingPhone.matches.length < SAMPLE_LIMIT) {
        enrMissingPhone.matches.push(toSample(c, undefined,
          manualFix(c.id, "Add a phone number."),
          "missing-phone"));
      }
    }
    if (!c.company) {
      if (enrMissingCompany.matches.length < SAMPLE_LIMIT) {
        enrMissingCompany.matches.push(toSample(c, undefined,
          manualFix(c.id, "Set a company so the contact can be grouped/routed."),
          "missing-company"));
      }
    }
    if (!c.firstName || !c.lastName) {
      if (enrMissingName.matches.length < SAMPLE_LIMIT) {
        const missing = !c.firstName && !c.lastName ? "both" : (!c.firstName ? "first" : "last");
        enrMissingName.matches.push(toSample(c, `missing: ${missing}`,
          manualFix(c.id, `Add ${missing === "both" ? "first and last name" : missing + " name"}.`),
          "missing-name"));
      }
    }
    if (!c.lifecycleStage) {
      if (enrMissingLifecycle.matches.length < SAMPLE_LIMIT) {
        enrMissingLifecycle.matches.push(toSample(c, undefined,
          manualFix(c.id, "Set a lifecycle stage (default: Lead)."),
          "missing-lifecycle"));
      }
    }
    if (!c.ownerId) {
      if (enrMissingOwner.matches.length < SAMPLE_LIMIT) {
        enrMissingOwner.matches.push(toSample(c, undefined,
          manualFix(c.id, "Assign a HubSpot owner."),
          "missing-owner"));
      }
    }
  }

  // We tracked counts by appending to capped sample arrays, so do a second
  // pass to compute the *true* counts (not just the truncated samples).
  function trueCount(predicate: (c: HubSpotContact) => boolean): number {
    let n = 0;
    for (const c of contacts) if (predicate(c)) n++;
    return n;
  }

  const fmtBuckets: IssueBucket[] = [
    {
      ...fmtNameCase,
      count: trueCount(c => {
        const fn = c.firstName || ""; const ln = c.lastName || "";
        return (!!fn && (isAllLower(fn) || isAllUpper(fn))) || (!!ln && (isAllLower(ln) || isAllUpper(ln)));
      }),
      samples: fmtNameCase.matches,
    },
    {
      ...fmtNameWhitespace,
      count: trueCount(c =>
        hasLeadingTrailingWhitespace(c.firstName, c.firstName?.trim() || null)
        || hasLeadingTrailingWhitespace(c.lastName, c.lastName?.trim() || null)),
      samples: fmtNameWhitespace.matches,
    },
    {
      ...fmtPhoneShape,
      count: trueCount(c => {
        const raw = c.phone || c.mobilePhone;
        if (!raw) return false;
        const digits = raw.replace(/\D+/g, "");
        return /[a-zA-Z]/.test(raw) || digits.length < 10 || digits.length > 11;
      }),
      samples: fmtPhoneShape.matches,
    },
    {
      ...fmtEmailWhitespace,
      count: trueCount(c => {
        if (!c.email) return false;
        const t = c.email.trim();
        return t !== c.email || /\s/.test(t) || !t.includes("@") || t.split("@").length !== 2;
      }),
      samples: fmtEmailWhitespace.matches,
    },
    {
      ...fmtEmailTypo,
      count: trueCount(c => !!c.email && isLikelyTypoEmail(c.email.trim().toLowerCase())),
      samples: fmtEmailTypo.matches,
    },
    {
      ...fmtJobTitleCase,
      count: trueCount(c => !!c.jobTitle && (isAllLower(c.jobTitle) || isAllUpper(c.jobTitle)) && !isAcronymJobTitle(c.jobTitle)),
      samples: fmtJobTitleCase.matches,
    },
  ].filter(b => b.count > 0).sort((a, b) => b.count - a.count);

  const enrBuckets: IssueBucket[] = [
    {
      ...enrNoContactInfo,
      count: trueCount(c => !normEmail(c.email) && !normPhone(c.phone) && !normPhone(c.mobilePhone)),
      samples: enrNoContactInfo.matches,
    },
    {
      ...enrMissingEmail,
      count: trueCount(c => !normEmail(c.email) && (!!normPhone(c.phone) || !!normPhone(c.mobilePhone))),
      samples: enrMissingEmail.matches,
    },
    {
      ...enrMissingPhone,
      count: trueCount(c => !!normEmail(c.email) && !normPhone(c.phone) && !normPhone(c.mobilePhone)),
      samples: enrMissingPhone.matches,
    },
    {
      ...enrMissingCompany,
      count: trueCount(c => !c.company),
      samples: enrMissingCompany.matches,
    },
    {
      ...enrMissingName,
      count: trueCount(c => !c.firstName || !c.lastName),
      samples: enrMissingName.matches,
    },
    {
      ...enrMissingLifecycle,
      count: trueCount(c => !c.lifecycleStage),
      samples: enrMissingLifecycle.matches,
    },
    {
      ...enrMissingOwner,
      count: trueCount(c => !c.ownerId),
      samples: enrMissingOwner.matches,
    },
    {
      ...enrGenericEmail,
      count: trueCount(c => !!c.email && isGenericEmail(c.email.trim().toLowerCase())),
      samples: enrGenericEmail.matches,
    },
  ].filter(b => b.count > 0).sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    totalContacts: contacts.length,
    wasTruncated: meta.wasTruncated,
    maxContactsConsidered: meta.maxContactsConsidered,
    hubspotPortalId: HUBSPOT_PORTAL_ID,
    summary: {
      // True totals from the full (uncapped) group lists.
      duplicateGroups:
        allDupByEmail.length +
        allDupByPhone.length +
        allDupByName.length +
        allDupBySimilarEmail.length,
      duplicateContacts: distinctDuplicateContactIds.size,
      formattingIssues: fmtBuckets.reduce((s, b) => s + b.count, 0),
      enrichmentOpportunities: enrBuckets.reduce((s, b) => s + b.count, 0),
    },
    duplicates: {
      byEmail: dupByEmail,
      byPhone: dupByPhone,
      byName: dupByName,
      bySimilarEmail: dupBySimilarEmail,
    },
    duplicateTotals: {
      byEmail: allDupByEmail.length,
      byPhone: allDupByPhone.length,
      byName: allDupByName.length,
      bySimilarEmail: allDupBySimilarEmail.length,
    },
    formatting: fmtBuckets,
    enrichment: enrBuckets,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Apply fixes back to HubSpot.
//
// The apply endpoint in routes.ts calls into this module so we keep all
// HubSpot Sandbox API knowledge in one place.

/** Walk a report and collect every (actionId → ProposedFix) pair. Used by
 *  the apply endpoint to look up fixes by id. */
export function collectActionsFromReport(report: ContactQualityReport): Map<string, ProposedFix> {
  const map = new Map<string, ProposedFix>();
  for (const bucket of [
    report.duplicates.byEmail,
    report.duplicates.byPhone,
    report.duplicates.byName,
    report.duplicates.bySimilarEmail,
  ]) {
    for (const g of bucket) map.set(g.actionId, g.fix);
  }
  for (const b of report.formatting) {
    for (const s of b.samples) {
      if (s.actionId && s.fix) map.set(s.actionId, s.fix);
    }
  }
  for (const b of report.enrichment) {
    for (const s of b.samples) {
      if (s.actionId && s.fix) map.set(s.actionId, s.fix);
    }
  }
  return map;
}

// ── Merge preview ──────────────────────────────────────────────────────
// Curated list of HubSpot contact properties shown in the customize-merge
// dialog by default. The "show all" toggle expands this to every property
// returned by /crm/v3/properties/contacts.
export const USEFUL_MERGE_FIELDS: { key: string; label: string; group: string }[] = [
  { key: "firstname", label: "First name", group: "Identity" },
  { key: "lastname", label: "Last name", group: "Identity" },
  { key: "email", label: "Email", group: "Identity" },
  { key: "phone", label: "Phone", group: "Identity" },
  { key: "mobilephone", label: "Mobile phone", group: "Identity" },
  { key: "company", label: "Company", group: "Identity" },
  { key: "jobtitle", label: "Job title", group: "Identity" },
  { key: "website", label: "Website", group: "Identity" },
  { key: "lifecyclestage", label: "Lifecycle stage", group: "Lifecycle" },
  { key: "hs_lead_status", label: "Lead status", group: "Lifecycle" },
  { key: "hubspot_owner_id", label: "Contact owner (id)", group: "Lifecycle" },
  { key: "address", label: "Street address", group: "Address" },
  { key: "city", label: "City", group: "Address" },
  { key: "state", label: "State", group: "Address" },
  { key: "zip", label: "Zip", group: "Address" },
  { key: "country", label: "Country", group: "Address" },
];

export interface MergePreviewContact {
  id: string;
  isPrimary: boolean;
  createdate: string | null;
  lastmodifieddate: string | null;
  /** Counts of objects associated with this contact in HubSpot. Surfaced in
   *  the customize-merge dialog so the user can see what data each duplicate
   *  is carrying before deciding which to merge. HubSpot's merge endpoint
   *  natively transfers all of these (and engagements) to the primary, so
   *  nothing is lost — but the user may want to preserve the contact with
   *  the most-attached data as primary. Zero on fetch failure (non-fatal). */
  associationCounts: { deals: number; tickets: number; companies: number };
}

export interface MergePreviewField {
  key: string;
  label: string;
  group: string;
  /** True when at least two contacts disagree (treating null/empty as same). */
  hasConflict: boolean;
  /** True when HubSpot rejects PATCHes to this property (calculated /
   *  read-only / system fields). The UI disables overrides on these so the
   *  user can't accidentally trigger a pre-merge PATCH that aborts the merge. */
  readOnly: boolean;
  values: Array<{ contactId: string; value: string | null }>;
}

export interface MergePreview {
  primaryContactId: string;
  contacts: MergePreviewContact[];
  fields: MergePreviewField[];
  showingAllProperties: boolean;
  fieldCount: number;
  conflictCount: number;
}

interface ContactPropertyMeta {
  name: string;
  /** True if HubSpot rejects PATCHes to this property (calculated, system,
   *  or readOnlyValue=true). */
  readOnly: boolean;
}

let cachedAllContactProperties: { props: ContactPropertyMeta[]; expiresAt: number } | null = null;

async function getAllContactProperties(token: string): Promise<ContactPropertyMeta[]> {
  const now = Date.now();
  if (cachedAllContactProperties && cachedAllContactProperties.expiresAt > now) {
    return cachedAllContactProperties.props;
  }
  const url = `${HUBSPOT_API_BASE}/crm/v3/properties/contacts`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to load property metadata: ${res.status} ${text.substring(0, 200)}`);
  }
  const j = (await res.json()) as {
    results?: {
      name?: string;
      calculated?: boolean;
      modificationMetadata?: { readOnlyValue?: boolean };
    }[];
  };
  const props: ContactPropertyMeta[] = (j.results || [])
    .map(r => ({
      name: typeof r.name === "string" ? r.name : "",
      readOnly: !!(r.calculated || r.modificationMetadata?.readOnlyValue),
    }))
    .filter(p => p.name.length > 0)
    // HubSpot has hundreds of internal/calc properties; the user can still see
    // them but we drop a few obvious noise prefixes to keep the dialog usable.
    .filter(p => !p.name.startsWith("hs_v_") && !p.name.startsWith("hs_analytics_") && !p.name.startsWith("hs_email_") && !p.name.startsWith("hs_social_"));
  cachedAllContactProperties = { props, expiresAt: now + 60 * 60 * 1000 };
  return props;
}

/** Returns the set of property names the sandbox token can PATCH. Used to
 *  validate override keys submitted from the customize-merge dialog before
 *  attempting a pre-merge PATCH (which would abort the whole merge on a
 *  single read-only key). Curated useful fields are always allowed because
 *  they're known-writable HubSpot defaults. */
export async function getWritableContactPropertyKeys(): Promise<Set<string>> {
  const token = getHubSpotToken();
  const all = await getAllContactProperties(token);
  const set = new Set<string>(USEFUL_MERGE_FIELDS.map(f => f.key));
  for (const p of all) {
    if (!p.readOnly) set.add(p.name);
  }
  return set;
}

/** Fetch the count of associated records of `toObjectType` for each contact
 *  id, using HubSpot's v4 batch associations endpoint (max 100 per call).
 *  Non-fatal: on error returns zero for the affected ids and warns, so the
 *  customize-merge dialog still loads. */
async function fetchAssociationCounts(
  token: string,
  ids: string[],
  toObjectType: "deals" | "tickets" | "companies",
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const url = `${HUBSPOT_API_BASE}/crm/v4/associations/contacts/${toObjectType}/batch/read`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
      });
      // Default every id in this batch to zero, then overlay actual counts.
      for (const id of batch) out.set(id, 0);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[HubSpot Sandbox] Association count fetch failed (${toObjectType}): ${res.status} ${text.substring(0, 120)}`);
        continue;
      }
      const j = (await res.json()) as { results?: Array<{ from?: { id?: string }; to?: unknown[] }> };
      for (const r of j.results || []) {
        const fid = r.from?.id;
        if (typeof fid !== "string") continue;
        out.set(fid, Array.isArray(r.to) ? r.to.length : 0);
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : "Unknown error";
      console.warn(`[HubSpot Sandbox] Association count fetch threw (${toObjectType}): ${m}`);
      for (const id of batch) if (!out.has(id)) out.set(id, 0);
    }
  }
  return out;
}

async function batchReadContactProperties(
  token: string,
  ids: string[],
  propertyKeys: string[],
): Promise<Map<string, Record<string, string | null>>> {
  // HubSpot's batch/read accepts the property list in the body so we don't hit
  // URL length limits when "show all" enumerates hundreds of properties.
  const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/read`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: ids.map(id => ({ id })), properties: propertyKeys }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Batch read failed: ${res.status} ${text.substring(0, 200)}`);
  }
  const j = (await res.json()) as { results?: Array<{ id: string; properties?: Record<string, string | null> }> };
  const out = new Map<string, Record<string, string | null>>();
  for (const r of j.results || []) out.set(r.id, r.properties || {});
  return out;
}

function pickOldestId(ids: string[]): string {
  return [...ids].sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  })[0];
}

/** Build the per-field comparison table the customize-merge dialog renders.
 *  Always uses the oldest contact id as primary (same rule as duplicate
 *  detection) so the dialog matches the proposed merge fix. */
export async function buildMergePreview(ids: string[], opts: { showAll?: boolean }): Promise<MergePreview> {
  // Dedupe ids defensively — a duplicated id would produce a phantom column
  // in the comparison and skew conflict detection.
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length < 2) throw new Error("Need at least 2 unique contact ids");
  const token = getHubSpotToken();
  const primaryContactId = pickOldestId(uniqueIds);

  let propertyKeys: string[];
  const labelMap = new Map(USEFUL_MERGE_FIELDS.map(f => [f.key, { label: f.label, group: f.group }]));
  // Curated useful fields are all standard editable HubSpot contact properties.
  const readOnlyKeys = new Set<string>();
  if (opts.showAll) {
    const all = await getAllContactProperties(token);
    propertyKeys = Array.from(new Set([...USEFUL_MERGE_FIELDS.map(f => f.key), ...all.map(p => p.name)]));
    for (const k of propertyKeys) {
      if (!labelMap.has(k)) labelMap.set(k, { label: k, group: "Other" });
    }
    for (const p of all) {
      if (p.readOnly) readOnlyKeys.add(p.name);
    }
  } else {
    propertyKeys = USEFUL_MERGE_FIELDS.map(f => f.key);
  }
  const propsToFetch = Array.from(new Set([...propertyKeys, "createdate", "lastmodifieddate"]));
  // Properties + association counts in parallel — both are independent reads
  // and the dialog needs all four to render the header columns.
  const [propsMap, dealsMap, ticketsMap, companiesMap] = await Promise.all([
    batchReadContactProperties(token, uniqueIds, propsToFetch),
    fetchAssociationCounts(token, uniqueIds, "deals"),
    fetchAssociationCounts(token, uniqueIds, "tickets"),
    fetchAssociationCounts(token, uniqueIds, "companies"),
  ]);

  const contacts: MergePreviewContact[] = uniqueIds.map(id => {
    const props = propsMap.get(id) || {};
    return {
      id,
      isPrimary: id === primaryContactId,
      createdate: props.createdate ?? null,
      lastmodifieddate: props.lastmodifieddate ?? null,
      associationCounts: {
        deals: dealsMap.get(id) ?? 0,
        tickets: ticketsMap.get(id) ?? 0,
        companies: companiesMap.get(id) ?? 0,
      },
    };
  });

  const fields: MergePreviewField[] = propertyKeys.map(key => {
    const meta = labelMap.get(key) || { label: key, group: "Other" };
    const values = uniqueIds.map(id => ({ contactId: id, value: propsMap.get(id)?.[key] ?? null }));
    const distinct = new Set(values.map(v => (v.value ?? "").trim()));
    return {
      key,
      label: meta.label,
      group: meta.group,
      hasConflict: distinct.size > 1,
      readOnly: readOnlyKeys.has(key),
      values,
    };
  });

  // Conflicts first (most actionable), then by group, then alphabetically.
  const groupOrder = ["Identity", "Lifecycle", "Address", "Other"];
  fields.sort((a, b) => {
    if (a.hasConflict !== b.hasConflict) return a.hasConflict ? -1 : 1;
    const ga = groupOrder.indexOf(a.group), gb = groupOrder.indexOf(b.group);
    if (ga !== gb) return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
    return a.label.localeCompare(b.label);
  });

  return {
    primaryContactId,
    contacts,
    fields,
    showingAllProperties: !!opts.showAll,
    fieldCount: fields.length,
    conflictCount: fields.filter(f => f.hasConflict).length,
  };
}

async function hubspotPatchContact(
  token: string,
  contactId: string,
  properties: Record<string, string>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  return { ok: false, message: `${res.status} ${text.substring(0, 500)}` };
}

async function hubspotMergePairOnce(
  token: string,
  primaryId: string,
  secondaryId: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/merge`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ primaryObjectId: primaryId, objectIdToMerge: secondaryId }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, message: `${res.status} ${text.substring(0, 500)}` };
}

/** Merge a pair, with self-heal for HubSpot's "forward reference" error.
 *
 *  When a contact has been previously merged, HubSpot keeps a non-canonical
 *  ghost record that points to the canonical ID. Attempting to merge such a
 *  ghost (on either side) yields:
 *    400 Cannot merge ObjectCoordinates{... objectId=X} because it has a
 *        forward reference to Y. Only canonical objects can be merged.
 *
 *  When that happens we parse out X (the ghost) and Y (the canonical),
 *  substitute Y in for whichever side X was on, and retry once. The result
 *  carries a `selfHealed` flag so the caller can surface that to the user. */
async function hubspotMergePair(
  token: string,
  primaryId: string,
  secondaryId: string,
  hooks?: {
    /** Invoked AFTER detecting a forward-reference and BEFORE the retry merge
     *  runs, but only when the canonical id is being substituted into the
     *  SECONDARY slot (i.e. the canonical id is about to be deleted). The
     *  caller can use this to snapshot the canonical id's properties while
     *  the contact still exists, so undo can later reconstruct it. */
    onBeforeSecondarySelfHeal?: (canonicalId: string) => Promise<void>;
  },
): Promise<
  | { ok: true; selfHealed?: { from: string; to: string; side: "primary" | "secondary" } }
  | { ok: false; message: string }
> {
  const first = await hubspotMergePairOnce(token, primaryId, secondaryId);
  if (first.ok) return { ok: true };

  // Match the forward-reference error and recover.
  const m = first.message.match(/objectId=(\d+).*?forward reference to (\d+)/s);
  if (!m) return { ok: false, message: first.message };
  const ghost = m[1];
  const canonical = m[2];

  let newPrimary = primaryId;
  let newSecondary = secondaryId;
  let side: "primary" | "secondary";
  if (ghost === primaryId) {
    newPrimary = canonical;
    side = "primary";
  } else if (ghost === secondaryId) {
    newSecondary = canonical;
    side = "secondary";
  } else {
    // Ghost wasn't either side we passed — can't safely retry.
    return { ok: false, message: first.message };
  }
  // Don't accidentally try to merge a contact with itself after substitution.
  if (newPrimary === newSecondary) {
    return { ok: true, selfHealed: { from: ghost, to: canonical, side } };
  }
  // Snapshot the canonical secondary BEFORE the retry deletes it. Failure of
  // the hook is intentionally swallowed: a missing snapshot only degrades
  // undo fidelity for this one secondary, not the merge itself.
  if (side === "secondary" && hooks?.onBeforeSecondarySelfHeal) {
    try { await hooks.onBeforeSecondarySelfHeal(canonical); } catch { /* noop */ }
  }
  const second = await hubspotMergePairOnce(token, newPrimary, newSecondary);
  if (second.ok) return { ok: true, selfHealed: { from: ghost, to: canonical, side } };
  return {
    ok: false,
    message: `Tried self-heal (${side} ${ghost} → canonical ${canonical}) but retry also failed: ${second.message}`,
  };
}

/** Execute a single proposed fix against the sandbox HubSpot. The actionId
 *  is supplied by the caller (it already lives on the cached issue) and is
 *  echoed back in the result so the UI can correlate.
 *
 *  For customized merges (`overrides.chosenProperties` present) we run merges
 *  FIRST, then PATCH the primary with the chosen values. Doing it the other
 *  way around (PATCH-then-merge) hits HubSpot's email-uniqueness constraint
 *  whenever the user picks a secondary's email — the secondary still owns
 *  that email, so the PATCH is rejected with a 400. After merging, the
 *  secondaries are gone, so no other contact claims the email and the PATCH
 *  succeeds. Net result is identical to "primary wins with overrides". */
export async function applyFix(
  actionId: string,
  fix: ProposedFix,
  overrides?: { chosenProperties?: Record<string, string> },
  hooks?: {
    /** Forwarded to hubspotMergePair so callers can snapshot canonical
     *  secondaries that get substituted in by self-heal, before the retry
     *  deletes them. Lets the change log later reconstruct them on undo. */
    onBeforeSecondarySelfHeal?: (canonicalId: string) => Promise<void>;
  },
): Promise<ApplyFixResult> {
  if (fix.kind === "manual") {
    return { actionId, status: "skipped", message: "Manual review only — no auto-fix available." };
  }
  const token = getHubSpotToken();
  if (fix.kind === "update") {
    if (!fix.properties || Object.keys(fix.properties).length === 0) {
      return { actionId, status: "skipped", message: "No properties to update." };
    }
    const r = await hubspotPatchContact(token, fix.contactId, fix.properties);
    if (r.ok) return { actionId, status: "applied" };
    return { actionId, status: "failed", message: r.message };
  }
  // merge: process pairs sequentially against the primary. Track each pair
  // outcome so partial successes are reported honestly — the caller invalidates
  // its cache on any non-zero success count, not just on full success.
  const failures: string[] = [];
  const selfHealed: string[] = [];
  // Track the actual deleted contact id for every successful pair, so the
  // change log can reconstruct precisely what was removed.
  const mergedSecondaryIds: string[] = [];
  let succeeded = 0;
  for (const secId of fix.mergeContactIds) {
    const r = await hubspotMergePair(token, fix.primaryContactId, secId, hooks);
    if (r.ok) {
      succeeded++;
      // If self-heal substituted the SECONDARY (the one that gets deleted),
      // the actually-deleted record is the canonical id, not the original
      // ghost. Primary-side substitution doesn't change what's deleted.
      if (r.selfHealed && r.selfHealed.side === "secondary") {
        mergedSecondaryIds.push(r.selfHealed.to);
      } else {
        mergedSecondaryIds.push(secId);
      }
      if (r.selfHealed) {
        selfHealed.push(`${r.selfHealed.side} ${r.selfHealed.from} → canonical ${r.selfHealed.to}`);
      }
    } else {
      failures.push(`${secId}: ${r.message}`);
    }
  }

  // Apply user-chosen field overrides AFTER merges so unique-constraint fields
  // (email above all) aren't blocked by the soon-to-be-deleted secondary still
  // holding the value. Skip if no merges succeeded — the primary's neighbors
  // would still claim those values.
  const chosen = overrides?.chosenProperties;
  let overrideStatus: { ok: true } | { ok: false; message: string } | null = null;
  if (chosen && Object.keys(chosen).length > 0 && succeeded > 0) {
    overrideStatus = await hubspotPatchContact(token, fix.primaryContactId, chosen);
  }

  // Roll up: report merge + override outcome together so the UI status badge
  // tells the truth (a merge can succeed while the override patch fails, e.g.
  // if the user picked an email still claimed by a contact that wasn't part
  // of this group).
  const overrideFailedMsg = overrideStatus && !overrideStatus.ok
    ? ` Override update failed: ${overrideStatus.message}`
    : "";

  const selfHealMsg = selfHealed.length > 0
    ? ` Auto-resolved ${selfHealed.length} previously-merged ghost contact(s): ${selfHealed.join("; ")}.`
    : "";

  if (failures.length === 0) {
    if (overrideStatus && !overrideStatus.ok) {
      return { actionId, status: "partial", message: `All merges succeeded but field overrides did not apply.${overrideFailedMsg}${selfHealMsg}`, mergedSecondaryIds };
    }
    if (selfHealed.length > 0) {
      return { actionId, status: "applied", message: selfHealMsg.trim(), mergedSecondaryIds };
    }
    return { actionId, status: "applied", mergedSecondaryIds };
  }
  if (succeeded > 0) {
    return {
      actionId,
      status: "partial",
      message: `${succeeded}/${fix.mergeContactIds.length} merged. Failed pairs: ${failures.join("; ")}.${overrideFailedMsg}${selfHealMsg}`,
      mergedSecondaryIds,
    };
  }
  return { actionId, status: "failed", message: `Failed pairs: ${failures.join("; ")}` };
}

// ──────────────────────────────────────────────────────────────────────
// Change-log support: snapshot + undo (reconstruct) helpers.
//
// Snapshotting reads ALL writable contact properties for the given ids before
// a merge runs, so an undo can rebuild the deleted secondaries with their
// pre-merge state. HubSpot has no unmerge endpoint, so this is reconstruct-
// only — new VIDs, no engagement history. The UI labels this clearly.

/** Read every writable property for the given contact ids. Returns a map id →
 *  property bag. Used both before merges (so undo can recreate the deleted
 *  secondaries) and as a sanity snapshot for property updates. */
export async function snapshotContactsForUndo(
  ids: string[],
): Promise<Map<string, Record<string, string | null>>> {
  if (ids.length === 0) return new Map();
  const token = getHubSpotToken();
  const writable = await getWritableContactPropertyKeys();
  // Always include identity-ish fields even if HubSpot marks them read-only,
  // so the detail drawer can show who the secondary was.
  const propsToFetch = Array.from(new Set([
    ...Array.from(writable),
    "firstname", "lastname", "email", "phone", "mobilephone", "company", "jobtitle",
  ]));
  return await batchReadContactProperties(token, ids, propsToFetch);
}

/** POST a contact to HubSpot using the snapshot properties. Strips empty/null
 *  values and (on first failure) retries without uniqueness-prone fields
 *  (email + phone) to maximise the chance the row reappears even if the
 *  primary now claims the original email. Returns the new contact id or an
 *  explanation of why it could not be recreated. */
async function recreateContactFromSnapshot(
  token: string,
  snapshot: Record<string, string | null>,
  writable: Set<string>,
): Promise<{ ok: true; id: string; strippedUniqueFields: boolean } | { ok: false; message: string }> {
  // Build a clean props payload: drop nulls/empties, drop anything HubSpot
  // marks read-only (createdate, hs_object_id, calculated fields, etc).
  const baseProps: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === null || v === undefined || v === "") continue;
    if (!writable.has(k)) continue;
    baseProps[k] = v;
  }
  if (Object.keys(baseProps).length === 0) {
    return { ok: false, message: "Snapshot had no writable properties to restore." };
  }
  const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts`;
  const post = async (props: Record<string, string>) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    const text = await res.text().catch(() => "");
    if (res.ok) {
      try {
        const j = JSON.parse(text) as { id?: string };
        if (j.id) return { ok: true as const, id: j.id };
      } catch { /* fall through */ }
      return { ok: false as const, message: "HubSpot returned 200 but no id" };
    }
    return { ok: false as const, message: `${res.status} ${text.substring(0, 300)}` };
  };
  const first = await post(baseProps);
  if (first.ok) return { ok: true, id: first.id, strippedUniqueFields: false };
  // On any failure, retry once with email + phone stripped — those are the
  // fields most likely to collide with the canonical record that absorbed
  // them. Without this we'd hand back "fail" on the very common "email already
  // exists" case.
  const stripped: Record<string, string> = { ...baseProps };
  delete stripped.email;
  delete stripped.phone;
  delete stripped.mobilephone;
  if (Object.keys(stripped).length === 0) return { ok: false, message: first.message };
  const second = await post(stripped);
  if (second.ok) return { ok: true, id: second.id, strippedUniqueFields: true };
  return { ok: false, message: `${first.message} (retry without email/phone also failed: ${second.message})` };
}

/** Undo a logged "update" fix: PATCH the contact's property back to the
 *  recorded "before" value. */
export async function undoUpdateFix(
  contactId: string,
  before: Record<string, string | null>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = getHubSpotToken();
  // HubSpot requires string values; null becomes "" to clear a field.
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(before)) props[k] = v === null ? "" : v;
  if (Object.keys(props).length === 0) return { ok: false, message: "Nothing to revert." };
  return await hubspotPatchContact(token, contactId, props);
}

/** Undo a logged "merge" fix: recreate every deleted secondary as a new
 *  contact, using the snapshot taken right before the merge. */
export async function undoMergeFix(
  secondaries: { id: string; properties: Record<string, string | null> }[],
): Promise<{
  recreatedIds: string[];
  skipped: { originalId: string; reason: string }[];
  strippedUniqueFields: string[];
}> {
  const token = getHubSpotToken();
  const writable = await getWritableContactPropertyKeys();
  const recreatedIds: string[] = [];
  const skipped: { originalId: string; reason: string }[] = [];
  const strippedUniqueFields: string[] = [];
  for (const sec of secondaries) {
    const r = await recreateContactFromSnapshot(token, sec.properties, writable);
    if (r.ok) {
      recreatedIds.push(r.id);
      if (r.strippedUniqueFields) strippedUniqueFields.push(sec.id);
    } else {
      skipped.push({ originalId: sec.id, reason: r.message });
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return { recreatedIds, skipped, strippedUniqueFields };
}

/** Best-effort issue-type label, derived from the actionId scope (e.g.
 *  "merge:by-phone:..." or "update:12345:firstname"). The UI groups change-log
 *  rows by this label so users can see "name-case fixes vs duplicate-by-phone
 *  merges" at a glance. */
export function deriveIssueTypeFromActionId(actionId: string, fix: ProposedFix): string {
  // Action ids are "merge:<primary>:<sortedIds>" or "update:<id>:<scope>".
  const parts = actionId.split(":");
  if (fix.kind === "merge") {
    // The duplicate-group bucket label isn't directly on the actionId; the
    // group's reason is though, but we've lost that here. Fallback to
    // "duplicate-merge" — the change-log surfaces the merged contact ids in
    // the detail view so the user can tell which group it was.
    return "duplicate-merge";
  }
  if (fix.kind === "update" && parts.length >= 3) {
    return `update:${parts.slice(2).join(":")}`;
  }
  return fix.kind;
}
