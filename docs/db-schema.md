# Database Schema

This document describes the core database design for the Elite SACCO Mbarara application. The system uses a MySQL 8.0+ InnoDB database and stores operational data, authorization metadata, financial records, and configuration in a normalized relational schema.

## Overview

The schema covers:

- User authentication and role-based access control
- SACCO members and non-member borrowers
- Savings deposits and withdrawals
- Loan applications, approval, disbursement, and repayment tracking
- Audit logging for compliance and traceability
- Regulatory inputs and system configuration

## ER / Relationship Summary

```text
roles
  └── users
        ├── role_permissions
        ├── members (registered_by)
        ├── non_members (created_by)
        ├── savings_transactions (recorded_by)
        ├── loan_requests (requested_by / decided_by)
        ├── loans (disbursed_by)
        ├── loan_repayments (recorded_by)
        ├── audit_log (user_id)
        ├── regulatory_inputs (entered_by)
        └── settings (updated_by)

members
  ├── savings_transactions
  ├── loan_requests
  └── loans

non_members
  ├── loan_requests
  └── loans

loan_requests
  └── loans

loans
  └── loan_repayments
