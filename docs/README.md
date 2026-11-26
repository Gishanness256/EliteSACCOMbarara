# Elite SACCO Mbarara — Management System

A single-page web application for running a Savings and Credit Cooperative (SACCO): member registry, savings deposits and withdrawals, loan requests and approvals, loan repayments with monthly compounding interest, a general ledger, portfolio-at-risk monitoring, member statements, regulatory returns, and a tamper-resistant audit trail.

It ships as three files:

| File | Purpose |
|------|---------|
| `index.html` | The whole front end (HTML, CSS and JavaScript in one file, with the logo embedded) |
| `server.js` | A small Express + SQLite server that serves the app and stores its data |
| `app.db` | The SQLite database (pre-seeded with the schema, roles, permissions and one Admin user) |

> *"ELITE SACCO MBARARA, GUARANTEED SUCCESS"*
> Developed by Gisha-Tech Innovations · © 2026 Elite SACCO Mbarara

---

## Table of contents

1. [Features](#features)
2. [Quick start](#quick-start)
3. [Configuration](#configuration)
4. [First login and first steps](#first-login-and-first-steps)
5. [Roles and permissions](#roles-and-permissions)
6. [Module guide](#module-guide)
7. [Business rules](#business-rules)
8. [Regulatory returns](#regulatory-returns)
9. [Importing and exporting data](#importing-and-exporting-data)
10. [Architecture](#architecture)
11. [HTTP API](#http-api)
12. [Database schema](#database-schema)
13. [Backups and recovery](#backups-and-recovery)
14. [Security notes](#security-notes)
15. [Known limitations](#known-limitations)
16. [Troubleshooting](#troubleshooting)
17. [Project layout](#project-layout)

---

## Features

- **Public pages**: Login, About Us and Services tabs, plus a "Create Account" dialog.
- **Role-based dashboard** with four roles (Admin, Treasurer, Credit Supervisor, Credit Officer) and an editable permission matrix.
- **Member management**: auto-numbered accounts (`ES-F 000001` / `ES-M 000001`), passport photo, NIN, contact details.
- **Savings**: deposits and withdrawals with channel, slip number and remarks, a 12-month per-member savings grid, and bulk import from Excel/CSV.
- **Loans**: request → Admin approval → active loan → repayment → cleared, for both members and non-members.
- **Pricing engine**: suggested monthly rate by loan category, term and member status (always editable).
- **Loan ledger**: principal/interest split on every repayment, balance tracking, overdue and cleared status.
- **General ledger** combining savings and loan events chronologically.
- **Liquidity / PAR** dashboard: Portfolio at Risk at 30, 60 and 90+ days, ageing buckets and an overdue list.
- **Reports**: weekly, monthly and annual activity reports with charts; per-member statements (monthly, quarterly, annual) in Excel, CSV and PDF.
- **Regulatory returns**: seven prudential-return templates with benchmark compliance checks, export to PDF and Excel.
- **System Auditor**: time-stamped, filterable, exportable activity log (including failed logins).
- **Persistent storage** in SQLite with automatic rolling snapshots.

---

## Quick start

### Requirements

- Node.js 18 or newer (a version supported by `better-sqlite3`)
- npm
- An internet connection in the browser for the Excel/PDF libraries and the Manrope web font (loaded from CDNs, see [Known limitations](#known-limitations))

### Install and run

Put `server.js`, `index.html` and `app.db` in the same folder, then:

```bash
npm init -y
npm install express better-sqlite3
node server.js
```

Open **http://localhost:8080**.

If `better-sqlite3` fails to build, install your platform's build tools (on Windows, the "Desktop development with C++" workload; on Debian/Ubuntu, `build-essential` and `python3`).

### Verify it is running

```bash
curl http://localhost:8080/healthz      # → ok
```

If the app shows a red bar saying *"Server storage is unavailable: changes are NOT being saved"*, the page is open but cannot reach `/api/state`. Start (or restart) `server.js` and reload.

---

## Configuration

All settings are environment variables, all optional.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | TCP port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to share on a network (read [Security notes](#security-notes) first) |
| `DB_FILE` | `./app.db` | Path to the SQLite database |
| `HTML_FILE` | `./index.html` | Path to the front-end file |

Example:

```bash
PORT=3000 HOST=0.0.0.0 DB_FILE=/var/lib/esacco/app.db node server.js
```

Windows PowerShell:

```powershell
$env:PORT=3000; node server.js
```

Compile-time constants in `server.js`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `BODY_LIMIT` | `50mb` | Maximum request body (member photos are stored inline as data URLs, so state can grow) |
| `SNAPSHOT_EVERY_MS` | 10 minutes | Minimum gap between history snapshots |
| `SNAPSHOT_KEEP` | 50 | Number of snapshots retained in `state_history` |

On first start, if the database holds no state and an old `esacco-data.json` sits beside the server, it is imported automatically.

---

## First login and first steps

The seeded database contains one system user:

| Field | Value |
|-------|-------|
| Login handle | `admin@elitesacco.co.ug` (typing just `admin` also works) |
| Password | `Admin` |
| Role | Admin |

The default password applies only while the Admin account has no password set. **Change it immediately** (Configurations → Users → *Reset credentials*).

Recommended setup order:

1. **Change the Admin credentials.**
2. **Create system users** for staff (Configurations → Users). Handles are always `name@elitesacco.co.ug`; passwords need at least 6 characters.
3. **Review access levels** (Configurations → Access Levels).
4. **Set up regulatory details** (Reports → Auditing): regulator name, licence number, benchmarks and provision rates.
5. **Register members** (Members).
6. Start recording **deposits**, **loan requests** and **repayments**.
7. If migrating from paper or spreadsheets, import historical savings and loans (see [Importing and exporting data](#importing-and-exporting-data)).

---

## Roles and permissions

### Roles

`Admin`, `Treasurer`, `Credit Supervisor`, `Credit Officer`.

### Permission matrix (defaults)

Editable by Admin at Configurations → Access Levels. The Admin column is locked on.

| Permission | Admin | Treasurer | Credit Supervisor | Credit Officer |
|------------|:----:|:---------:|:-----------------:|:--------------:|
| Approve loans | ✔ | | ✔ | |
| Acknowledge savings/deposits | ✔ | ✔ | | ✔ |
| Acknowledge loan repayments | ✔ | ✔ | ✔ | ✔ |
| Set interest rates | ✔ | | ✔ | |
| Create/remove system users | ✔ | | | |
| Create/remove member accounts | ✔ | | | |
| Weekly reports | ✔ | ✔ | ✔ | |
| Monthly reports | ✔ | ✔ | ✔ | |
| Annual reports | ✔ | ✔ | | |

### Menu-level restrictions (fixed in code)

Some screens are gated by role directly, independent of the matrix above:

| Screen | Roles allowed |
|--------|---------------|
| Loan Requests, Loans Section | Admin, Credit Officer, Credit Supervisor |
| Loan Approval (approve / reject / hold) | **Admin only** |
| System Auditor | Admin, Treasurer |
| Reports → Auditing (regulatory returns) | Admin, Treasurer, Credit Supervisor |
| Create users / reset credentials / remove users | Admin only |
| Edit regulatory configuration and monthly inputs | Admin, Treasurer |

The matrix permissions that are enforced in the interface today are *Acknowledge savings/deposits* (recording deposits and withdrawals) and *Acknowledge loan repayments* (recording payments). The remaining entries are stored and editable but access to those screens is governed by the fixed role list above.

---

## Module guide

### Login / About / Services (public)

- **Login**: email or phone-style handle plus password. Every successful and failed attempt is written to the audit log.
- **Create Account**: a registration dialog (first name, last name, address, phone, email, password, NIN, terms). *This form is currently a front-end stub: it validates input and then shows a message; it does not create a record.* Members are registered by staff under **Members**.
- **About Us** and **Services** describe the SACCO and its loan products (Special, Normal, Secured Business, Agricultural, School Fees) for civil servants, teachers, medical workers, pensioners, security officers and other salary earners.

### Dashboard (home)

KPI tiles: members, total savings, loans outstanding, system users. The left sidebar expands on hover and can be pinned or hidden.

### Configurations

- **Users**: create system users (name, handle, initials, role, password), reset a user's handle and password, remove users, and register **non-member borrowers** (name, telephone, optional NIN). Only Admin can create, reset or remove.
- **Access Levels**: tick which permissions each role holds; *Reset defaults* restores the table above.

### Members

Add or edit members: first and last name, date of birth, gender (F/M), address, NIN (stored upper-case), telephone, email, and a passport photo. The account number is generated as `ES-<F|M> <six-digit sequence>`, e.g. `ES-F 000001`. The gender letter is locked once the member exists.

### Savings

- **Deposits / Withdrawals**: pick a member, choose deposit or withdrawal, enter amount, date/time, channel (Counter / Cash, Mobile money, Bank transfer, Salary deduction, Agent), optional slip number and remarks. Each entry gets a reference `SV-000001`, `SV-000002`, … Withdrawals larger than the current balance are refused. Shows the latest 25 transactions and a 12-month savings grid per member. Bulk import via Excel or CSV with a downloadable template.
- **Accounts** (Member Accounts): one row per member with deposits, withdrawals, savings balance, loans taken, repayments, loan outstanding, active loans and net position (savings − outstanding loans). Searchable. The **Statement** button opens a monthly, quarterly or annual statement exportable to Excel, CSV or PDF, with opening and closing balances for savings and loans.

### Loans

1. **Loan Requests**: create a request for a member or a non-member. Choose category, term (1–60 months), amount and rate. The suggested rate is pre-filled and may be edited (0.01–30 % per month). Requests get IDs `LR-0001`, `LR-0002`, … and start as *Pending*.
2. **Loan Approval** (Admin): approve, reject or put on hold. A remark is **required** for reject and hold. Member standing (savings and existing loan balance) is shown beside each request. Approving creates an active loan (`LN-0001`, …) dated today.
3. **Loans Section**: filter active, cleared or all loans; search by name, account or reference; open a loan to see principal, rate, starting balance, instalment estimate and full repayment history; record payments (*Installment*, *Lump sum* or *Clear full balance*). A payment cannot be dated before disbursement, in the future, or earlier than the previous payment, and cannot exceed the balance due on that date. Export to Excel, CSV or PDF, and import historical loans (see below).

### Portfolio

- **Ledger**: every savings transaction, loan disbursement and loan repayment in date order, with running savings and loan balances and officer initials. Non-member borrowers appear in italics.
- **Liquidity**: Portfolio at Risk dashboard. See [PAR](#portfolio-at-risk-par).

### Reports

- **Statements**: weekly (last 7 days), monthly (last 30 days) or annual (last 12 months) report with KPIs, a narrative summary, a bar chart of deposits, loans and repayments, a cash-mix donut and a breakdown table. Export to CSV or print.
- **Auditing**: regulatory returns. See [Regulatory returns](#regulatory-returns).

### System Auditor

Read-only activity log with time, officer initials, user, role, activity and particulars. Filter by user, activity, date range and free text; export the filtered view to CSV or print. The newest 500 matching entries are displayed (export for all). Logged events include logins and failed logins, logouts, member, user, access-level and credential changes, savings entries, loan requests and decisions, repayments, imports, exports and report generation.

---

## Business rules

### Account and reference numbers

| Item | Format | Example |
|------|--------|---------|
| Member account | `ES-<F/M> <6 digits>` | `ES-M 000042` |
| Savings transaction | `SV-<6 digits>` | `SV-000017` |
| Loan request | `LR-<4 digits>` | `LR-0003` |
| Loan | `LN-<4 digits>` | `LN-0003` |

Non-members have no account number.

### Savings balance

`balance = Σ deposits − Σ withdrawals`. Withdrawals cannot exceed the current balance.

### Loan pricing

All rates are **percent per month**.

```
suggested rate = category base + term adjustment + non-member surcharge
```

| Category | Base rate |
|----------|----------:|
| Normal Loan | 3.0 % |
| Special Loan | 2.5 % |
| Secured Business Loan | 2.5 % |
| Agricultural Loan | 2.0 % |
| School Fees Loan | 2.0 % |

| Term | Adjustment |
|------|-----------:|
| ≤ 6 months | +0.00 % |
| 7–12 months | +0.25 % |
| > 12 months | +0.50 % |

Non-members pay an extra **1.0 %** per month. The user may overwrite the suggestion; the rate typed in is the one applied. The tables live in the `CATS`, `termAdj` and `NONMEM_EXTRA` definitions in the Loans module of `index.html` ("Edit here to change pricing").

### Loan balance and interest

- The **starting balance** is `principal × (1 + rate)`: the first month's interest is charged up front.
- On each monthly anniversary of the disbursement date, the outstanding balance (after payments received in the period) is multiplied by `(1 + rate)`. Interest therefore **compounds monthly**.
- Repayments are applied to **interest first, then principal**; the history shows the split for each payment.
- A loan is **Cleared** when its balance falls below UGX 0.50, **Overdue** when it is uncleared and past `disbursement date + term`, otherwise **Active**.
- Instalment guidance uses the standard annuity formula `PMT = P·r / (1 − (1+r)^−n)`.

### Portfolio at Risk (PAR)

`PAR n = outstanding balance of loans overdue by ≥ n days ÷ total outstanding balance`

Due date is `disbursement date + term`. Buckets: current, 1–29, 30–59, 60–89 and 90+ days. Active loans with no recorded term are excluded from the ageing (the screen tells you how many).

### Loan approval workflow

```
Pending ──► Approved ──► Loan created (LN-xxxx) ──► Active ──► Cleared
   │ ▲
   ├──► On Hold (remark required) ─┘ (can be decided later)
   └──► Rejected (remark required)
```

Only Admin may decide. Decisions record who decided, when, and the remark.

---

## Regulatory returns

Reports → Auditing generates prudential returns for a microfinance regulator. The default regulator is *Uganda Microfinance Regulatory Authority (UMRA)*; name, registration/licence number and benchmarks are editable by Admin and Treasurer.

### Templates

1. Prudential Ratios Summary
2. Statement of Financial Position
3. Statement of Income
4. Liquidity Return
5. Capital Adequacy Return
6. Portfolio Quality & Loan Loss Provisioning
7. Membership & Savings Return

### Reporting bases

| Basis | Description |
|-------|-------------|
| Month-end snapshot | Position as at the end of one month |
| Month-on-month average | 3, 6 or 12 months to the chosen month, with average, total (flows) and change vs prior month |
| Year-on-year average (YTD) | January to the chosen month, compared with the same months of the previous year |

Only months from the first recorded transaction onward are included, and the report states how many months were used.

### Data sources

Loans, savings and accrued interest are computed automatically from system records. Items the system does not track are entered under **Monthly financial inputs**:

- *Balance items* (carried forward until changed): cash on hand, bank balances, other liquid investments, other assets, other liabilities, member share capital, statutory/other reserves.
- *Flow items* (that month only): fee and other income, interest/dividends paid on savings, operating expenses.

Missing inputs are treated as zero and listed in the report notes.

### Default benchmarks (indicative; verify with your regulator)

| Setting | Default |
|---------|--------:|
| Minimum liquidity ratio | 15 % |
| Minimum core capital ÷ total assets | 10 % |
| Minimum institutional capital ÷ total assets | 8 % |
| Maximum PAR 30 | 5 % |
| Maximum PAR 90 | 2 % |
| Provision rates (current / 1–29 / 30–59 / 60–89 / 90+ days) | 1 / 5 / 25 / 50 / 100 % |

Each ratio row with a benchmark shows **Compliant** or **Breach**.

### Exports

Single return or **full pack**, as PDF (A4 landscape) or Excel (one sheet per return), plus print. Each export carries a header (regulator, licence number, basis, months included) and signature blocks for *Prepared by*, *Reviewed by (Treasurer)* and *Approved by (Manager / Chairperson)*.

The layout follows a common prudential-return structure. If your regulator prescribes an exact form, transfer the figures to it before submission.

---

## Importing and exporting data

### Savings import (Excel or CSV)

Download the template from Savings → Deposits / Withdrawals.

| Column | Required | Notes |
|--------|:--------:|-------|
| Account | Yes | Existing member account, e.g. `ES-F 000001` |
| Date | Yes | `YYYY-MM-DD`, optionally with `HH:MM` |
| Amount | Yes | Positive number in UGX |
| Type | Yes | `Deposit` or `Withdrawal` |
| Channel | No | Counter / Cash, Mobile money, Bank transfer, Salary deduction, Agent |
| Slip No. | No | |
| Remarks | No | |

### Loan import (`.xlsx`, `.xls`, `.csv` or text-based `.pdf`)

Download the template from Loans → Loans Section. Columns: Account (blank for non-members), Name, Telephone, Category, Term (months), Principal, Rate (% per month), Date Disbursed, Status (Active/Cleared), Balance or Amount Paid, Date Cleared. Header names are matched flexibly (e.g. "phone", "contact" and "tel" are all accepted). Rows are checked for duplicates and unknown accounts, and a summary of imported, duplicate and rejected rows is shown. PDF import works only for text-based tables, not scanned images.

### Exports

| Data | Formats |
|------|---------|
| Loans list | Excel, CSV, PDF |
| Member statements | Excel, CSV, PDF |
| Activity reports | CSV, print |
| Audit log | CSV, print |
| Regulatory returns | Excel, PDF, print |

---

## Architecture

```
┌────────────────────────┐        HTTP / JSON         ┌───────────────────────┐
│ Browser: index.html    │ ─────────────────────────► │ server.js (Express)   │
│  • whole app state `S` │  GET/PUT /api/state        │                       │
│  • all business logic  │ ◄───────────────────────── │  better-sqlite3       │
│  • XLSX / jsPDF / pdf.js│                           │        │              │
└────────────────────────┘                            └────────┼──────────────┘
                                                               ▼
                                                           app.db (SQLite, WAL)
                                                       app_state · state_history · relational tables
```

- **The front end owns the logic.** `index.html` loads the entire application state (`users`, `members`, `savings`, `loans`, `reqs`, `non`, `audit`, `roles`, `regin`, `rcfg`, sequence counters) as one JSON document from `/api/state`, works on it in memory, and writes it back.
- **Saving is debounced** (250 ms after the last change), serialised so writes never overlap, and flushed with `navigator.sendBeacon` when the page closes. A red banner appears if a save fails.
- **The server validates only the envelope**: the body must be a JSON object with a `users` array. It stores the document in `app_state` (single row, `id = 1`).
- **Rolling history**: before overwriting state, the server copies the previous version into `state_history` if the last snapshot is at least 10 minutes old, keeping the latest 50.
- **SQLite** runs in WAL mode with `synchronous = NORMAL` and a 5-second busy timeout. Shutdown on `SIGINT`/`SIGTERM` closes the database cleanly.
- **Third-party libraries** (loaded from cdnjs): SheetJS `xlsx 0.18.5`, `jspdf 2.5.1`, `jspdf-autotable 3.8.2`, `pdf.js 3.11.174`. Font: Manrope (Google Fonts).

### Relational tables vs. the state document

`app.db` also contains normalised tables (`members`, `savings`, `loans`, …), two views and a read/write JSON API over them (see below). **In the current version the web interface reads and writes only the `app_state` document through `/api/state`; it does not call `/api/data` or `/api/save`.** The relational tables are therefore empty unless something else fills them. They are provided for reporting, integrations and future migration. Treat `app_state` as the source of truth.

---

## HTTP API

### App and state

| Method | Path | Description |
|--------|------|-------------|
| GET | `/`, `/index.html` | The application |
| GET | `/healthz` | Returns `ok` |
| GET | `/api/state` | Full state JSON; `204` if nothing is saved yet |
| PUT / POST | `/api/state` | Replace state (`POST` exists for `sendBeacon`). Returns `204`; `400` if the body is not a state object |

### Relational API (JSON)

```bash
# Everything (password column never returned)
curl http://localhost:8080/api/data

# One table, with paging, ordering and exact-match filters
curl "http://localhost:8080/api/data?table=savings&limit=50&offset=0&order=date&dir=desc"
curl "http://localhost:8080/api/data?table=savings&acc=ES-F%20000001"

# A read-only view
curl "http://localhost:8080/api/data?view=v_loans"

# Upsert one or many records (by primary key)
curl -X POST http://localhost:8080/api/save \
  -H "Content-Type: application/json" \
  -d '{"table":"savings","record":{"ref":"SV-000001","acc":"ES-F 000001","amt":50000,"date":"2026-03-15","is_withdrawal":0}}'
```

Behaviour:

- Reachable tables: `users`, `permissions`, `role_permissions`, `members`, `non_members`, `savings`, `loan_requests`, `loans`, `loan_repayments`, `audit_log`, `reg_inputs`, `settings`. Views: `v_member_savings`, `v_loans`. `app_state` and `state_history` are not exposed.
- `users.password` is never returned.
- `/api/save` accepts `record` (object) or `records` (array, max 5000), runs in one transaction (all or nothing), rejects unknown columns and nested values, enforces NOT NULL columns on insert, and returns `{ok, table, saved, rows}`.
- `audit_log` is insert-only (database triggers reject UPDATE and DELETE).
- Errors: `400` bad input, `404` unknown table/view, `405` wrong method or append-only violation, `409` constraint violation, `413` payload too large, `500` server error.

> These endpoints are not authenticated and writes made through `/api/save` are **not** visible to the web interface (which reads `app_state`). Use them with care.

---

## Database schema

Tables created and shipped in `app.db`:

| Table | Key columns | Notes |
|-------|-------------|-------|
| `app_state` | `id` (=1), `json`, `updated` | **The live application data** |
| `state_history` | `id`, `data`, `created_at` | Rolling snapshots (created by `server.js`) |
| `users` | `id`, `name`, `email` (unique, case-insensitive), `role`, `initials`, `password` | Role limited to the four roles |
| `permissions` | `idx`, `name` | Nine permissions |
| `role_permissions` | `(role, perm_idx)`, `allowed` | 4 × 9 matrix |
| `members` | `acc` (PK), `first`, `last`, `dob`, `addr`, `nin`, `tel`, `email`, `photo` | |
| `non_members` | `id`, `name`, `tel`, `nin` | Borrowers without accounts |
| `savings` | `id`, `ref` (unique), `acc`, `amt` (>0), `date`, `is_withdrawal`, `officer_ini`, `channel`, `slip`, `remarks` | Indexed on `acc` and `date` |
| `loan_requests` | `id`, `date`, `type` (`m`/`n`), `acc`, `nid`, `category`, `term`, `amt`, `rate`, `status`, decision fields | Status: Pending, On Hold, Approved, Rejected |
| `loans` | `id`, `ref`, `request_id`, `acc`, `nid`, `amt`, `rate`, `date`, `category`, `term`, `imported` | Must have a member account or a non-member id |
| `loan_repayments` | `id`, `loan_id` (cascade), `date`, `amt` (>0), `type`, `officer_ini` | |
| `audit_log` | `id`, `t`, `initials`, `user`, `role`, `action`, `particulars` | Append-only via triggers |
| `reg_inputs` | `(month, key)`, `value` | Keys: `cash bank liq oa ol sh rs fee sint opx` |
| `settings` | `key`, `value` | Counters (`seq`, `lseq`, `sseq`) and regulatory config (`rcfg`) |

Views:

- `v_member_savings`: per-member deposits, withdrawals and balance.
- `v_loans`: loan list with borrower name, principal, rate, disbursement and due date, and total paid.

---

## Backups and recovery

**Back up** by copying `app.db` while the server is stopped. If the server is running (WAL mode), also copy `app.db-wal` and `app.db-shm`, or, safer, use SQLite's online backup:

```bash
sqlite3 app.db ".backup 'backup-$(date +%F).db'"
```

**Recover a bad save** from the rolling history. Stop the server, then:

```bash
sqlite3 app.db "SELECT id, created_at, length(data) FROM state_history ORDER BY id DESC LIMIT 10;"
sqlite3 app.db "UPDATE app_state SET json = (SELECT data FROM state_history WHERE id = <ID>), updated = datetime('now') WHERE id = 1;"
```

Snapshots are taken at most every 10 minutes and only the newest 50 are kept, so they cover a few hours of heavy use, not long-term history. Keep regular file backups as well.

**Exports** (Excel/CSV/PDF) of loans, statements and the audit log are useful offline archives.

---

## Security notes

Please read before deploying anywhere other than a single trusted computer.

1. **Login is enforced in the browser only.** `/api/state` and the relational API have no authentication. Anyone who can reach the server can read or replace all data. Keep `HOST=127.0.0.1`, or put the server behind HTTPS and an authenticating reverse proxy (e.g. nginx or Caddy with basic auth or SSO) before exposing it.
2. **Passwords are stored in plain text** inside the state document, and are sent to the browser with it. The seeded Admin has no stored password and uses the default `Admin`. Use long unique passwords and restrict network access; do not reuse passwords from other systems.
3. **Role checks run in the browser.** A technically capable user can bypass them via the API. Treat roles as an operational control for honest staff, not a security boundary.
4. **Personal data**: the database holds NINs, phone numbers, addresses and photos. Protect `app.db` and its backups, and handle them under Uganda's Data Protection and Privacy Act, 2019.
5. **The audit log in the app is append-only in the UI**, but because the whole state is replaceable via `/api/state`, it is not tamper-proof against someone with API access. The relational `audit_log` table has database-level triggers; the state-based log does not.
6. Serve over **HTTPS** if the app is reachable beyond localhost.

---

## Known limitations

- **Single document storage**: the whole state is rewritten on every save. Fine for a small SACCO (the log is capped at 5,000 entries), but inline photos make the document grow, so use modest photo sizes.
- **Last write wins**: with two browsers open, the later save overwrites the earlier one. Use one active session at a time, or reload before working.
- **The "Create Account" dialog is a placeholder** and does not register anyone.
- **Relational tables are not wired to the UI** (see [Architecture](#relational-tables-vs-the-state-document)).
- **Internet required in the browser** for Excel/PDF import and export libraries and for the web font. Host the libraries locally for offline use.
- **Savings "withdrawal" and loan "disbursement" are bookkeeping records**: the app does not move money.
- **Interest rules are fixed in code** (monthly compounding with first month's interest up front). Changing the method means editing `bal()`, `sim()` and `sbal()` in `index.html`.
- **No password self-service**: a forgotten password or handle is reset by the Admin.
- **Regulatory benchmarks and provisions are indicative** and must be confirmed against the regulator's current rules.
- **Loan approval date**: approved loans are dated the day of approval, not the request date.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| Red banner "Server storage is unavailable" | `server.js` is not running or the browser cannot reach it. Start it and reload. Unsaved changes made while the banner was showing are lost |
| `Cannot find module 'express'` / `better-sqlite3` | Run `npm install express better-sqlite3` in the project folder |
| `better-sqlite3` build errors | Install build tools, or use a Node version with prebuilt binaries |
| Blank page or "Cannot read …index.html" | `index.html` must be next to `server.js`, or set `HTML_FILE` |
| `EADDRINUSE` | Port is taken. Use `PORT=8081 node server.js` |
| Cannot log in as Admin | Use `admin` (or `admin@elitesacco.co.ug`) with password `Admin`, unless it has been changed. If it was changed and forgotten, restore a snapshot from `state_history` or edit the state JSON |
| "PDF/Excel library could not load" | The browser cannot reach cdnjs. Check the internet connection |
| Loan import says "Imported 0 …" | Check headers against the template, that member accounts exist, and that dates are valid |
| `/api/data` tables are empty | Expected. The app stores its data in `app_state` |
| Can't reach the app from another computer | Start with `HOST=0.0.0.0`, allow the port through the firewall, and read the security notes |

---

## Project layout

```
.
├── server.js     # Express + better-sqlite3 server (state API, relational API, static app)
├── index.html    # Complete single-page front end
├── app.db        # SQLite database (created/seeded; do not commit real data)
└── README.md
```

Runtime files created beside the database: `app.db-wal` and `app.db-shm` (SQLite write-ahead log, while the server runs).

---

## Credits

Developed by **Gisha-Tech Innovations** for **Elite SACCO Mbarara** (formerly Obwesigwa Financial Services), a licensed Savings and Credit Society Limited company serving civil servants, teachers, medical workers, pensioners, security officers and other salary earners.
