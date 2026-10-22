# Elite SACCO Mbarara — Web App

A single-file, dependency-light web application for running a Savings and Credit
Cooperative (SACCO). It ships as one `index.html` plus a `404.html` fallback for
GitHub Pages — no build step, no server, no database. All state is stored in
the browser's `localStorage`, and the heavy lifting (Excel/PDF parsing and
generation) is handled by libraries loaded from a CDN.

> Tagline: *"Elite SACCO Mbarara, Guaranteed Success"*

---

## Table of contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Project structure](#project-structure)
4. [Quick start (local)](#quick-start-local)
5. [Deploy to GitHub Pages](#deploy-to-github-pages)
6. [First run & default credentials](#first-run--default-credentials)
7. [Roles & permissions](#roles--permissions)
8. [Admin guide — module by module](#admin-guide--module-by-module)
9. [Loan pricing reference](#loan-pricing-reference)
10. [Backup, restore & data](#backup-restore--data)
11. [Regulatory returns](#regulatory-returns)
12. [Troubleshooting](#troubleshooting)
13. [Credits & licence](#credits--licence)

---

## Features

- **Authentication** — login with `name@elitesacco.co.ug` + password; default
  Admin account ships out of the box.
- **Members** — register account holders (account numbers like
  `ES-F 000001`), capture DOB, gender, address, NIN, telephone, email, and a
  passport photo.
- **Non-members** — register one-off borrowers without an account number.
- **Savings** — record deposits and withdrawals per member, with channels
  (Counter/Cash, Mobile money, Bank transfer, Salary deduction, Agent), slip
  numbers, and remarks. Import historical savings from `.xlsx`, `.xls`, or
  `.csv`.
- **Loans** — request → approve → manage lifecycle. Categories include Normal,
  Special, Secured Business, Agricultural, and School Fees loans, each with its
  own monthly interest rate. Supports imports from `.xlsx`, `.xls`, `.csv`,
  **and text-based PDFs**.
- **Portfolio** — a real-time **general ledger** (savings + loan activity
  chronologically), and a **Liquidity / Portfolio-at-Risk (PAR)** dashboard
  with 30 / 60 / 90+ day ageing buckets.
- **Reports** — weekly / monthly / annual financial reports with SVG bar and
  donut charts; per-member account **statements** exportable to Excel, CSV,
  and PDF.
- **Auditing** — every meaningful action is logged with timestamp, officer
  initials, user, role, activity, and particulars. The log is filterable and
  exportable.
- **Regulatory returns** — generates prudential-return templates aligned to
  UMRA-style ratios (liquidity, capital adequacy, PAR, loan-loss provisioning,
  membership & savings, statements of financial position and income), with
  benchmarks, sign-off blocks, and full-pack PDF/Excel export.
- **404 fallback** — `404.html` preserves deep links in `sessionStorage` and
  bounces visitors back into the SPA.

---

## Tech stack

| Layer            | Choice                                                                |
| ---------------- | --------------------------------------------------------------------- |
| Markup & styles  | Hand-written HTML + CSS in a single `index.html`                      |
| Scripting        | Vanilla JavaScript (no framework)                                    |
| Persistence      | Browser `localStorage` under the key `esacco`                         |
| Excel I/O        | [SheetJS](https://sheetjs.com/) `xlsx.full.min.js` 0.18.5             |
| PDF generation   | [`jsPDF`](https://github.com/parallax/jsPDF) 2.5.1 + autotable 3.8.2   |
| PDF parsing      | [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174                   |
| Fonts            | Google Fonts — Manrope (400–800)                                      |
| Hosting          | GitHub Pages (or any static host)                                     |

No bundler. No `node_modules`. No CI required.

---

## Project structure

```
.
├── index.html      ← the entire SPA (rename from index-2.html)
├── 404.html        ← GitHub Pages fallback (deep-link rescue)
└── README.md       ← this file
```

That's it. If you later add a logo image instead of the inline base64, drop it
next to `index.html` and update the `src` references.

---

## Quick start (local)

You have two options.

### Option A — double-click
Just open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari).

### Option B — serve locally (recommended)
Some browsers restrict `localStorage` and the file-pickers when loading from
`file://`. Serve the folder over HTTP to avoid surprises:

```bash
# Python 3 (built in)
python3 -m http.server 8080

# Or Node.js
npx serve .
```

Then visit <http://localhost:8080/>.

---

## Deploy to GitHub Pages

This is the easiest hosting option and it's free.

### 1. Create the repository
- Go to <https://github.com/new>.
- Name it whatever you like (e.g. `elite-sacco`).
- **Do not** initialise with a README — you already have one.
- Click **Create repository**.

### 2. Push the files
From your local folder:

```bash
git init
git add .
git commit -m "Initial commit: Elite SACCO Mbarara app"
git branch -M main
git remote add origin https://github.com/<your-username>/elite-sacco.git
git push -u origin main
```

### 3. Enable Pages
- In the repo, go to **Settings → Pages**.
- Under **Build and deployment**:
  - **Source**: `Deploy from a branch`
  - **Branch**: `main` / `(root)` / `Save`
- Wait ~30–60 seconds for the first build.

### 4. Open the site
- User/org Pages: `https://<your-username>.github.io/`
- Project Pages: `https://<your-username>.github.io/elite-sacco/`

Both `index.html` and `404.html` are served automatically — deep links that
don't match a real file fall through to `404.html`, which bounces visitors
back to the app.

### 5. Subsequent updates
Just commit to `main` and push. Pages rebuilds automatically on every push.

> **Tip:** If you use a custom domain, add a `CNAME` file in the same folder
> containing your domain (e.g. `app.elitesacco.co.ug`).

---

## First run & default credentials

The app ships with one **System Admin** account pre-installed.

| Field    | Value                          |
| -------- | ------------------------------ |
| Handle   | `admin`                        |
| Email    | `admin@elitesacco.co.ug`       |
| Password | `Admin`                        |

> **First thing you should do after first login**: open **Configurations →
> Users**, click **Reset credentials**, and set a strong password of at least
> 6 characters. The Admin role bypasses the permission grid, so guard it.

The login handle suffix `@elitesacco.co.ug` is hard-coded in `index.html`
(search for `const DOM='@elitesacco.co.ug'`). Change it there if your SACCO
uses a different domain.

---

## Roles & permissions

The permission model is a role × permission matrix editable from
**Configurations → Access Levels**.

**Roles** (fixed list):
1. **Admin** — all permissions, cannot be edited.
2. **Treasurer**
3. **Credit Supervisor**
4. **Credit Officer**

**Permissions** (tick per role):
- Approve loans
- Acknowledge savings/deposits
- Acknowledge loan repayments
- Set interest rates
- Create/remove system users
- Create/remove member accounts
- Weekly reports
- Monthly reports
- Annual reports

**Default matrix** (shipped out of the box):

| Permission                          | Admin | Treasurer | Credit Supervisor | Credit Officer |
| ----------------------------------- | :---: | :-------: | :---------------: | :------------: |
| Approve loans                       |  ✓    |           |        ✓          |                |
| Acknowledge savings/deposits        |  ✓    |     ✓     |                   |       ✓        |
| Acknowledge loan repayments         |  ✓    |     ✓     |        ✓          |       ✓        |
| Set interest rates                  |  ✓    |           |        ✓          |                |
| Create/remove system users          |  ✓    |           |                   |                |
| Create/remove member accounts       |  ✓    |           |                   |                |
| Weekly reports                      |  ✓    |     ✓     |        ✓          |                |
| Monthly reports                     |  ✓    |     ✓     |        ✓          |                |
| Annual reports                      |  ✓    |     ✓     |                   |                |

Use the **Reset defaults** button on the same screen to revert at any time.

Additionally, some modules have a hard-coded role gate that overrides the
matrix:

| Module            | Allowed roles                                              |
| ----------------- | ---------------------------------------------------------- |
| Loan Requests     | Admin, Credit Officer, Credit Supervisor                  |
| Loan Approval     | Admin                                                       |
| Loans Section     | Admin, Credit Officer, Credit Supervisor                   |
| System Auditor    | Admin, Treasurer                                           |
| Regulatory Returns | Admin, Treasurer, Credit Supervisor                      |

---

## Admin guide — module by module

Sign in as Admin to see every menu. Sidebar items show/hide automatically
based on the role gates above. Hover the rail to expand it; click the logo to
hide the sidebar for a blank "wall mode".

### Configurations → Users

- **Create system user** — enter full name, login handle (becomes
  `handle@elitesacco.co.ug`), initials, role, and a temporary password (≥6
  chars). The handle may contain only letters, numbers, dots, hyphens, and
  underscores.
- **Reset credentials** — pick any user, optionally change their handle, set a
  new password. Used when a user forgets their password or handle.
- **System users table** — list, **Reset** (jump to the reset form) or
  **Remove** (Admin role cannot be removed).
- **Non-members** — register ad-hoc borrowers (no account number) used in loan
  requests.

### Configurations → Access Levels

- Tick the matrix per role → **Save access levels**.
- Use **Reset defaults** to revert to the matrix shown above.
- Admin column is read-only.

### Members

- **Add member** — first name, last name, DOB, gender (drives the account
  number prefix: `ES-M` male / `ES-F` female), address, NIN, telephone,
  optional email, passport photo. Account number auto-generated as
  `ES-{G} {NNNNNN}`.
- **Edit** — click the **Edit** button on the members table to load a member
  back into the form.
- Account numbers are immutable once created (the gender select is disabled
  in edit mode).

### Savings → Deposits / Withdrawals

- **Record a deposit or withdrawal** — pick a member account, choose Deposit
  or Withdrawal, enter amount, date & time, channel, slip/reference number,
  and remarks. The current savings balance is shown beneath the member select.
  Withdrawals cannot exceed the current balance.
- **Import past savings** — upload `.xlsx`, `.xls`, or `.csv`. Required
  columns: `Account, Date, Amount, Type, Channel, Slip No., Remarks`.
  Templates (Excel + CSV) are downloadable from the same screen.
- **Recent transactions** table (last 25 entries) and a **per-month savings
  matrix** for every member round out the view.

### Savings → Member Accounts

- One row per member with deposits, withdrawals, savings balance, loans
  taken, repayments, loan outstanding, active loan count, and net position
  (savings − loans).
- Search by name or account number.
- Click **Statement** on any row to open the per-member statement generator
  (monthly / quarterly / annual), with Excel, CSV, and PDF exports.

### Loans → Loan Requests

- Available to: Admin, Credit Officer, Credit Supervisor.
- Pick applicant type (Member or Non-member). For members, choosing an account
  auto-fills name, telephone, email, address.
- Choose category, term (1–60 months), amount, and interest rate. The
  **suggested rate** is computed live (see [Loan pricing](#loan-pricing-reference))
  but is fully editable.
- Submit creates a request with status `Pending` and reference `LR-####`.

### Loans → Loan Approval

- Available to: **Admin only**.
- Shows pending + on-hold requests. For each, view the member's standing
  (savings balance and outstanding loans), enter a remark, then **Approve**,
  **Hold**, or **Reject**. A remark is mandatory for Hold and Reject.
- Approved requests automatically become active loans with reference `LN-####`
  and appear in the Loans Section.

### Loans → Loans Section

- Available to: Admin, Credit Officer, Credit Supervisor.
- **Filter** active / cleared / all loans; **search** by name, account, or
  loan ref.
- **Manage** a loan to record a repayment (Installment / Lump sum / Clear full
  balance), with a suggested installment amount computed from PMT.
- **Export** the current filter to Excel, CSV, or PDF.
- **Import** historical loans from `.xlsx`, `.xls`, `.csv`, or text-based
  PDFs. The PDF importer looks for a header row containing "Name" and
  "Principal" and treats each subsequent row as a loan. A downloadable
  template is provided.
- Loan statuses: `Active`, `Overdue` (term expired with balance), `Cleared`
  (balance < UGX 0.50).

### Portfolio → Ledger

A running chronological statement of every savings transaction, loan
disbursement, and loan repayment across the whole SACCO. Columns include
savings deposit/withdrawal, savings balance, loan disbursement, principal
repayment, interest paid, and loan balance per borrower. Non-member borrowers
appear in italics.

### Portfolio → Liquidity (PAR)

- KPIs: outstanding loan portfolio, **PAR 30 / 60 / 90+** (outstanding
  principal of loans past due by N+ days ÷ total outstanding).
- Ageing table (Current / 1–29 / 30–59 / 60–89 / 90+ days) with bucketed bar
  chart.
- Overdue loan detail table sorted by days overdue.
- Loans without a term are flagged and excluded from ageing.

### Reports → Statements

- Choose **weekly / monthly / annual** period.
- Generates KPI cards (deposits, loans disbursed, repayments, outstanding), a
  written statement of cash movement, an SVG activity bar chart, an SVG cash
  mix donut, and an interval breakdown table.
- Buttons: **Generate**, **Export CSV**, **Print / Save PDF** (uses the
  browser print dialog).

### Reports → Auditing — Regulatory Returns

Available to: Admin, Treasurer, Credit Supervisor.

The most powerful screen. Generates UMRA-aligned prudential return templates:

1. **Prudential Ratios Summary** — liquidity, capital adequacy, asset quality,
   earnings (operating self-sufficiency).
2. **Statement of Financial Position** — assets, liabilities, equity.
3. **Statement of Income** — interest income (accrual), fees, expenses,
   surplus.
4. **Liquidity Return** — liquid assets vs savings + short-term liabilities.
5. **Capital Adequacy Return** — core capital vs total assets.
6. **Portfolio Quality & Loan Loss Provisioning** — ageing buckets,
   provisions per bucket, PAR.
7. **Membership & Savings Return** — registered members, savers, borrowers,
   savings movement.

Each return supports:
- **Reporting basis**: month-end snapshot, month-on-month average (3/6/12
  months), or year-on-year average (Jan-to-month vs same period prior year).
- **As-at month** selector.
- **Benchmarks** (min liquidity, min core capital, max PAR 30, max PAR 90)
  with compliant / breach badges.
- **Monthly financial inputs** (cash on hand, bank balances, share capital,
  reserves, fee income, savings interest paid, operating expenses). Balance
  items carry forward; income/expense items apply to the selected month only.
- **Institution & benchmarks** settings — regulator name, licence number,
  provision rates per bucket.
- **Export** single return or **full pack** to PDF and Excel; **Print** for
  wet signatures.

### System Auditor

Available to: Admin, Treasurer. Read-only, filterable activity log (date range,
user, activity type, free-text particulars). Export to CSV or print. Entries
are append-only — they cannot be edited or deleted from the UI.

---

## Loan pricing reference

Interest is **monthly**, compounded on the outstanding balance.

### Base rates per category

| Category               | Base % / month |
| ---------------------- | :------------: |
| Normal Loan            |     3.00       |
| Special Loan           |     2.50       |
| Secured Business Loan  |     2.50       |
| Agricultural Loan      |     2.00       |
| School Fees Loan       |     2.00       |

### Adjustments

- **Term adjustment**: ≤6 months = +0.00%; ≤12 months = +0.25%; >12 months = +0.50%.
- **Non-member surcharge**: +1.00% / month (borrowers without a SACCO account).

### Suggested rate

```
suggested = base + term_adj + non_member_surcharge
```

The Loan Requests screen computes this live and pre-fills the rate field.
**The rate you actually save is the one applied** — feel free to override.

To change the base rates, edit `CATS` near the top of the `<script>` block in
`index.html`:

```js
const CATS = {
  'Normal Loan': 3,
  'Special Loan': 2.5,
  'Secured Business Loan': 2.5,
  'Agricultural Loan': 2,
  'School Fees Loan': 2,
};
const NONMEM_EXTRA = 1;            // extra % per month for non-members
const termAdj = t => t <= 6 ? 0 : t <= 12 ? .25 : .5;
```

---

## Backup, restore & data

### Where data lives
Everything is stored in the browser's `localStorage` under the key **`esacco`**
as a single JSON blob. No server. No sync.

### Backing up
Two safe ways:
1. **From the app**: open DevTools (F12) → Application → Local Storage → your
   site URL → copy the value of `esacco` into a `.json` file.
2. **From the console** (one-liner):
   ```js
   copy(JSON.stringify(JSON.parse(localStorage.getItem('esacco')), null, 2));
   ```
   Paste into `elite-sacco-backup-YYYY-MM-DD.json`.

### Restoring
On the target browser:
```js
localStorage.setItem('esacco', JSON.stringify(<pasted-object>));
location.reload();
```

### Resetting
To wipe all data and start fresh:
```js
localStorage.removeItem('esacco');
location.reload();
```
This reinstalls the default Admin account and an empty data set.

> **Caution**: data is per-browser. Two staff using two laptops will have two
> separate datasets. For a multi-user SACCO, designate one machine (or one
> browser profile) as the "live" ledger and back it up daily. A future
> version may add server sync — for now, treat it as a single-tenant
> workstation app.

---

## Regulatory returns

The **Auditing — Regulatory Returns** screen produces seven UMRA-aligned
templates (see [Admin guide](#admin-guide--module-by-module)). Key points:

- **Loans, savings, and interest** are computed automatically from system
  records (loan disbursements, repayments, ageing, etc.).
- **Balance-sheet items** (cash, bank, share capital, reserves, other assets
  / liabilities) are **not** tracked elsewhere — enter them monthly under
  "Monthly financial inputs". Balance items carry forward until changed;
  income/expense items are month-specific.
- **Provision rates** are configurable per ageing bucket. Defaults:
  `1% / 5% / 25% / 50% / 100%` (current / 1–29 / 30–59 / 60–89 / 90+ days).
- **Benchmarks** (min liquidity ≥15%, min core capital ≥10%, min institutional
  capital ≥8%, max PAR 30 ≤5%, max PAR 90 ≤2%) are indicative defaults.
  Confirm them against the regulator's current guidelines before submitting.
- Each exported return includes prepared-by / reviewed-by / approved-by sign-off
  blocks.

---

## Troubleshooting

| Symptom                                                | Likely cause / fix                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deep links (e.g. `/users`) return a 404                | Expected. GitHub Pages serves `404.html`, which bounces to the app root. Confirm `404.html` is at the repo root.                                            |
| Login fails on first run                                | You're typing the full handle — try just `admin` (the form auto-appends `@elitesacco.co.ug`). Password is `Admin` (capital A).                              |
| Charts / exports throw "library could not load"         | CDN is blocked. Check connectivity to `cdnjs.cloudflare.com` (SheetJS, jsPDF, pdf.js) and `fonts.googleapis.com` (Manrope).                                 |
| PDF loan import fails with "No loans table found"      | The PDF is image-based (a scan). Re-export from the source system as text, or use the Excel/CSV importer.                                                  |
| Data disappears after switching browsers               | Expected — `localStorage` is per-browser. Use the same browser profile, or restore from a JSON backup (see [Backup](#backup-restore--data)).              |
| Audit log is empty                                     | Logs are kept in `S.audit` inside the same `esacco` localStorage blob. They survive reloads but are capped at 5,000 entries (oldest auto-pruned).          |
| Interest rate column shows `0` or unexpected value      | Loans imported without a rate column default to the category's base + adjustments. Edit `CATS` in `index.html` if you want different defaults.              |
| Sidebar won't stay open                                 | Click the **Hide/Show dashboard** button (the ☰ icon at the top of the rail) to pin it open.                                                              |
| Everything looks unstyled                               | You opened `index.html` directly from `file://` and the browser blocked something. Serve via `python3 -m http.server` instead.                              |
| Logged in as Admin, "Reset" button is disabled         | Shouldn't happen — Admin can reset any user. Hard-refresh (`Ctrl+Shift+R`) to reload the script.                                                           |

### Hard reset
When in doubt, in the browser console:
```js
localStorage.removeItem('esacco');   // wipe all data
sessionStorage.removeItem('redirect'); // clear any stale 404 redirect
location.reload();
```
You'll land back on the login screen with the default Admin account.

---

## Credits & licence

- **Owner**: Elite SACCO Mbarara (formerly Obwesigwa Financial Services).
- **Developer**: Gisha-Tech Innovations.
- **Open-source libraries**: SheetJS (XLSX), jsPDF + autotable, pdf.js — see
  their respective licences.
- **Fonts**: Manrope by Mikhail Sharanda, served via Google Fonts.

© 2026 Elite SACCO Mbarara. All rights reserved.
