# Hubspot Data Cleanup

A standalone web app that audits a HubSpot portal for contact data-quality
issues, proposes fixes, lets you review and apply them (individually or in
bulk), and keeps a full change history with one-click undo.

This runs entirely on its own — connect it to any HubSpot portal with a
private-app token and a PostgreSQL database, and you're ready to clean up
contacts.

## What it does

- **Audit** — pages every contact in the connected HubSpot portal and surfaces
  three buckets of findings:
  1. **Duplicates** — grouped by email, normalized phone, or name + company.
  2. **Formatting** — capitalization, phone-number shape, common email typos.
  3. **Enrichment** — missing core fields, generic mailboxes, etc.
- **Review & apply** — each finding has a proposed fix (merge or property
  update). Pick one, many, or all, preview the change, then push it to HubSpot.
- **Selective merge** — narrow a duplicate group, choose which contact wins,
  and see live deal/ticket/company counts before merging.
- **Activity & undo** — every applied fix is logged. Property updates are
  reverted exactly; merges are reconstruct-only (HubSpot has no unmerge API, so
  undo recreates the secondaries as new contacts without engagement history).

All audit work is read-only; nothing changes in HubSpot until you apply a fix.

## Requirements

- Node.js 20+
- A PostgreSQL database (stores only the change-history table)

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string (for the change log). |
| `HUBSPOT_SANDBOX_API_KEY` | Yes | Private-app token for the HubSpot portal to audit. |
| `HUBSPOT_SANDBOX_PORTAL_ID` | No | Portal ID, used only to build "Open in HubSpot" deep links. |
| `PORT` | No | Port to serve on (defaults to 5000). |

> The token needs CRM scopes for reading and writing contacts (and reading
> associations): `crm.objects.contacts.read`, `crm.objects.contacts.write`,
> plus read access to deals/tickets/companies for the association counts.

## Set this up as its own Replit project

1. **Create a new repl** — In the Replit UI, create a new repl and import this
   folder (e.g. upload the zip and extract it, or push it to a Git repo and
   import that). This app has no dependency on any parent project.
2. **Add a database** — Provision a PostgreSQL database (Replit's built-in
   PostgreSQL works). This sets `DATABASE_URL` for you.
3. **Set the secrets** — In the repl's Secrets pane, add:
   - `HUBSPOT_SANDBOX_API_KEY` (required) — private-app token for the HubSpot
     portal you want to clean up.
   - `HUBSPOT_SANDBOX_PORTAL_ID` (optional) — portal ID, used only for
     "Open in HubSpot" deep links.
   - `PORT` (optional) — defaults to 5000.
4. **Install, migrate, run:**

```bash
npm install          # install dependencies
npm run db:push      # create the hubspot_change_log table
npm run dev          # start in development (Vite + Express on one port)
```

Open the app at the served URL. The audit runs on first load and is cached for
30 minutes; use the Refresh button to force a fresh pull.

## Production

```bash
npm run build        # bundles client + server into dist/
npm start            # serves the built app
```

## Project layout

```
client/                React + Vite frontend
  src/pages/hubspot-sandbox.tsx   the entire UI
  src/components/ui/              shared UI primitives
server/
  index.ts            Express entry
  routes.ts           the 5 /api/hubspot/sandbox-* routes
  hubspot-sandbox-analysis.ts     audit + fix + undo logic (HubSpot calls)
  storage.ts          change-log persistence
  db.ts               Drizzle + Postgres
shared/
  schema.ts           hubspot_change_log table + types
```

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/hubspot/sandbox-contacts-quality` | Run/return the cached audit. |
| GET | `/api/hubspot/sandbox-merge-preview?ids=a,b` | Per-field comparison for a merge. |
| POST | `/api/hubspot/sandbox-apply-fixes` | Apply selected fixes. |
| GET | `/api/hubspot/sandbox-change-log` | List applied fixes. |
| POST | `/api/hubspot/sandbox-change-log/:id/undo` | Undo a logged fix. |
