# Elite SACCO Mbarara API / Data Contract

This project does not expose a server-side REST API. The application stores and retrieves all operational data in the browser's `localStorage` under a single key named `esacco`.

The document below describes the internal data contract used by the app and the main data operations implemented in the UI.

---

## 1. Storage location

- Key: `esacco`
- Storage type: browser `localStorage`
- Structure: JSON object

Example:

```js
const state = {
  users: [],
  members: [],
  savings: [],
  loans: [],
  roles: {},
  seq: 0,
  non: [],
  reqs: [],
  lseq: 0,
  sseq: 0,
  audit: []
};

localStorage.setItem('esacco', JSON.stringify(state));
```

---

## 2. High-level data model

| Collection | Purpose | Key fields |
| --- | --- | --- |
| `users` | Staff/system users | `name`, `email`, `role`, `pw`, `ini` |
| `members` | SACCO account holders | `acc`, `first`, `last`, `dob`, `nin`, `tel`, `email`, `photo` |
| `savings` | Deposit and withdrawal records | `acc`, `amt`, `date`, `w`, `ref`, `ch`, `slip`, `rm` |
| `loans` | Loan records and loan lifecycle | `acc`, `nid`, `cat`, `term`, `amt`, `rate`, `date`, `status`, `reps`, `remark` |
| `non` | Non-member borrowers | `id`, `name`, `tel`, `nin` |
| `reqs` | Loan requests | `id`, `acc`, `nid`, `cat`, `term`, `amt`, `rate`, `status` |
| `roles` | Permission matrix by role | `Admin`, `Treasurer`, `Credit Supervisor`, `Credit Officer` |
| `audit` | Activity log | `t`, `ini`, `user`, `role`, `act`, `part` |

---

## 3. User model

```json
{
  "name": "System Admin",
  "email": "admin@elitesacco.co.ug",
  "role": "Admin",
  "ini": "SA",
  "pw": "Admin"
}
```

### Field definitions

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Full name of system user |
| `email` | string | yes | Login handle + `@elitesacco.co.ug` |
| `role` | string | yes | One of `Admin`, `Treasurer`, `Credit Supervisor`, `Credit Officer` |
| `ini` | string | no | User initials (for audit logs) |
| `pw` | string | no | Stored password for local auth |

### Default login

The application ships with a default admin account:

- Email: `admin@elitesacco.co.ug`
- Password: `Admin`

- ---

## 4. Member model

```json
{
  "acc": "ES-F 000001",
  "first": "Jane",
  "last": "Nabirye",
  "dob": "1992-01-15",
  "addr": "Mbarara",
  "nin": "CM1234567890",
  "tel": "+256700123456",
  "email": "jane@example.com",
  "photo": "data:image/jpeg;base64,...",
  "gender": "F"
}
```

### Notes

- Account numbers are auto-generated using the member gender prefix:
  - `ES-M` for male
  - `ES-F` for female
- `acc` is treated as immutable after creation.
- `photo` is stored as a base64 data URL when supplied.

---

## 5. Savings model

```json
{
  "acc": "ES-F 000001",
  "amt": 500000,
  "date": "2026-11-02",
  "w": false,
  "ref": "SV-000001",
  "ch": "Counter / Cash",
  "slip": "SLP-1001",
  "rm": "Monthly contribution",
  "ini": "SA"
}
```

### Field definitions

| Field | Type | Description |
| --- | --- | --- |
| `acc` | string | Member account number |
| `amt` | number | Amount in UGX |
| `date` | string | ISO date (`YYYY-MM-DD`) |
| `w` | boolean | `false` = deposit, `true` = withdrawal |
| `ref` | string | Savings transaction reference |
| `ch` | string | Channel (`Counter / Cash`, `Mobile money`, etc.) |
| `slip` | string | Slip or reference number |
| `rm` | string | Remarks/description |
| `ini` | string | Initials of recording officer |

### Validation rules

- Withdrawals cannot exceed the member's current balance.
- `amt` must be greater than `0`.
- `date` must be a valid date.

---

## 6. Loan model

```json
{
  "acc": "ES-F 000001",
  "nid": null,
  "cat": "Normal Loan",
  "term": 12,
  "amt": 2500000,
  "rate": 3.5,
  "date": "2026-11-01",
  "status": "Approved",
  "ref": "LN-0001",
  "remark": "Approved after review",
  "reps": [
    {
      "date": "2026-11-15",
      "amt": 250000,
      "t": "Installment",
      "ini": "SA"
    }
  ]
}
```

### Field definitions

| Field | Type | Description |
| --- | --- | --- |
| `acc` | string | Member account, if member borrower |
| `nid` | string/null | Non-member borrower id, if not member |
| `cat` | string | Loan category |
| `term` | number | Term in months |
| `amt` | number | Principal amount |
| `rate` | number | Monthly interest rate (%) |
| `date` | string | Disbursement date |
| `status` | string | `Pending`, `Approved`, `Rejected`, `On Hold`, `Cleared`, `Overdue`, `Active` |
| `ref` | string | Loan reference |
| `remark` | string | Approval/review remark |
| `reps` | array | Repayment entries |

### Loan categories

The app includes these pricing categories:

- `Normal Loan`
- `Special Loan`
- `Secured Business Loan`
- `Agricultural Loan`
- `School Fees Loan`

Rate calculation is based on:

- Base monthly rate per category
- Term adjustment
- Non-member surcharge

---

## 7. Non-member borrower model

```json
{
  "id": "l9xj2q",
  "name": "Alice Arinaitwe",
  "tel": "+256772111222",
  "nin": "CM9876543210"
}
```

Used when a borrower does not hold a SACCO member account.

---

## 8. Role and permission matrix

The application stores permissions in a nested object keyed by role:

```json
{
  "Admin": [true, true, true, true, true, true, true, true, true],
  "Treasurer": [false, true, true, false, false, false, true, true, true],
  "Credit Supervisor": [true, false, true, true, false, false, true, true, false],
  "Credit Officer": [false, false, true, false, false, false, false, false, false]
}
```

The matrix corresponds to permissions such as:

1. Approve loans
2. Acknowledge savings/deposits
3. Acknowledge loan repayments
4. Set interest rates
5. Create/remove system users
6. Create/remove member accounts
7. Weekly reports
8. Monthly reports
9. 9. Annual reports

---

## 9. Audit log model

```json
{
  "t": "2026-11-02T10:30:15.000Z",
  "ini": "SA",
  "user": "System Admin",
  "role": "Admin",
  "act": "Login",
  "part": "Signed in successfully"
}
```

Used for:

- Login/logout history
- User creation/reset
- Savings changes
- Loan approvals and rejections
- Report generation/export
- Data import/export actions

---

## 10. API-style operations used by the app

Although no backend endpoint exists, these are the functional operations represented by the static app's internal logic.

### Authentication

- `login(emailOrPhone, password)`
- Validates user credentials against `users`
- Applies default domain suffix: `@elitesacco.co.ug`

### User management

- `createUser({ name, email, role, ini, pw })`
- `resetCredentials(userId, newHandle, newPassword)`
- `removeUser(userId)`

### Member management

- `createMember(memberPayload)`
- `updateMember(memberId, memberPayload)`
- `removeMember(memberId)`

### Savings operations

- `recordDeposit({ acc, amt, date, channel, slip, remarks })`
- `recordWithdrawal({ acc, amt, date, channel, slip, remarks })`
- `importSavings(rows)`

### Loan operations

- `submitLoanRequest({ acc | nid, cat, term, amt, rate, member })`
- `approveLoan(loanId, remark)`
- `holdLoan(loanId, remark)`
- `rejectLoan(loanId, remark)`
- `recordRepayment({ loanId, amount, type, date })`
- `importLoans(rows)`

### Reporting and exports

- `generateStatement(period)`
- `generateRegulatoryReturn(type)`
- `exportCsv(data)`
- `printPdf()`

---

## 11. Example payloads

### Login request

```json
{
  "id": "admin",
  "password": "Admin"
}
```

### Create member request

```json
{
  "first": "Jane",
  "last": "Nabirye",
  "dob": "1992-01-15",
  "address": "Mbarara",
  "nin": "CM1234567890",
  "phone": "+256700123456",
  "email": "jane@example.com",
  "gender": "F"
}
```

### Record deposit request

```json
{
  "acc": "ES-F 000001",
  "amt": 100000,
  "date": "2026-11-02",
  "type": "deposit",
  "channel": "Counter / Cash",
  "slip": "SLP-998",
  "remarks": "Monthly savings"
}
```

---

## 12. Notes for future backend integration

If this app is later migrated to a real backend, the current `localStorage` schema can be mapped into a proper REST or database model with minimal change:

- `users` -> `staff` table
- `members` -> `members` table
- `savings` -> `savings_transactions`
- `loans` -> `loans`
- `non` -> `non_members`
- `audit` -> `audit_logs`
- `roles` -> `permissions` / `role_permissions`

A backend version should replace the browser-only persistence layer while keeping the same field names and semantics.

---

## 13. Summary

The app is a local-first, single-page business system. Its "API" is effectively the structure of the `esacco` JSON object stored in `localStorage`. All business logic is contained in the client application, and the data contract described here is the source of truth for the repository's operational model.

If you want, this file can also be expanded into a fuller OpenAPI-style reference or converted into a JSON Schema definition.
