# Backup and Restore

This document explains how to back up and restore the Elite SACCO Mbarara application data safely. It covers the database layer, application configuration, and operational checks recommended before and after a restore.

## 1. Scope

The application depends on a MySQL 8.0+ database for core business data, including:

- users and role permissions
- members and non-members
- savings transactions
- loan requests, loans, and repayments
- audit log
- regulatory inputs
- settings

This backup process focuses on the database and environment configuration needed to fully recover the system.

---

## 2. Backup Strategy

Use a layered backup approach:

1. Database logical backup
2. File-level backup of application config and secrets
3. Optional snapshot of the entire server or container volume
4. Retention policy and verification

### Recommended backup frequency

- Production: nightly full backup + daily incremental/differential if available
- High-change environments: hourly or at least every 6 hours
- Before major releases or migration work: create an ad hoc full backup

### Retention

Keep at least:

- 7 daily backups
- 4 weekly backups
- 12 monthly backups

Store backups in at least two locations:
- primary local backup storage
- off-site or cloud storage

---

## 3. Database Backup

### 3.1 Full logical backup with mysqldump

Use this when you need a portable SQL dump.

```bash
mysqldump --single-transaction --routines --triggers --events \
  --default-character-set=utf8mb4 \
  -u root -p elite_sacco > backups/elite_sacco_$(date +%F_%H%M%S).sql
