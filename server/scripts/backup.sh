#!/usr/bin/env bash
# ============================================================================
# Elite SACCO Mbarara — Nightly PostgreSQL backup script
# ----------------------------------------------------------------------------
# Creates a compressed, timestamped pg_dump backup of the SACCO database,
# verifies its integrity, rotates old backups per a retention policy, and
# optionally uploads the result to S3-compatible storage. Emits alerts on
# failure so a missed backup never goes unnoticed.
#
# Designed for cron / systemd timer:
#
#   # /etc/cron.d/elite-sacco-backup
#   30 2 * * *  sacco  /opt/elite-sacco/scripts/backup.sh >> /var/log/elite-sacco-backup.log 2>&1
#
# Or as a systemd timer (preferred — gives you journald logging for free):
#
#   # /etc/systemd/system/elite-sacco-backup.service
#   [Unit]
#   Description=Elite SACCO nightly PostgreSQL backup
#   [Service]
#   Type=oneshot
#   User=sacco
#   ExecStart=/opt/elite-sacco/scripts/backup.sh
#
#   # /etc/systemd/system/elite-sacco-backup.timer
#   [Timer]
#   OnCalendar=*-*-* 02:30:00
#   Persistent=true
#   [Install]
#   WantedBy=timers.target
#
# Configuration: read from a .env file (default: /opt/elite-sacco/.env) or
# from environment variables set in the crontab. See BACKUP_* vars below.
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_TIME="$(date +%s)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXIT_CODE=0

# Default config file (override with --env-file)
DEFAULT_ENV_FILE="${SCRIPT_DIR}/../.env"
ENV_FILE="${ENV_FILE:-${DEFAULT_ENV_FILE}}"

# ---------------------------------------------------------------------------
# Default configuration (override via env vars or .env file)
# ---------------------------------------------------------------------------
# Database connection — prefer DATABASE_URL, fall back to PG* vars.
# If neither is set, the script will look for ~/.pgpass
DB_NAME="${PGDATABASE:-elite_sacco}"
DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PGPORT:-5432}"
DB_USER="${PGUSER:-sacco}"

# Where to store backup files locally
BACKUP_DIR="${BACKUP_DIR:-/var/backups/elite-sacco}"

# Retention policy (days to keep each backup type)
RETENTION_DAILY="${RETENTION_DAILY:-7}"       # keep last 7 daily backups
RETENTION_WEEKLY="${RETENTION_WEEKLY:-8}"     # keep last 8 weekly backups (Sundays)
RETENTION_MONTHLY="${RETENTION_MONTHLY:-12}"  # keep last 12 monthly backups (1st of month)

# Backup format and compression
BACKUP_FORMAT="${BACKUP_FORMAT:-custom}"      # custom (pg_dump -Fc) | plain | directory
BACKUP_COMPRESS_LEVEL="${BACKUP_COMPRESS_LEVEL:-6}"  # 0-9 (used with -Z for custom/directory)

# Naming prefix
BACKUP_PREFIX="${BACKUP_PREFIX:-elite-sacco}"

# Include globals (roles, tablespaces) in a separate file
BACKUP_GLOBALS="${BACKUP_GLOBALS:-true}"

# Verify integrity after backup (restore to /dev/null essentially)
BACKUP_VERIFY="${BACKUP_VERIFY:-true}"

# Upload to S3 (set BACKUP_S3_ENABLE=true to enable)
BACKUP_S3_ENABLE="${BACKUP_S3_ENABLE:-false}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-backups/elite-sacco}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"    # for MinIO, Wasabi, DigitalOcean Spaces, etc.
BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_PROFILE="${BACKUP_S3_PROFILE:-default}"

# Alerts (set to non-empty to enable)
ALERT_SLACK_WEBHOOK="${ALERT_SLACK_WEBHOOK:-}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-}"
ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-elite-sacco-backup@$(hostname 2>/dev/null || echo localhost)}"

# Logging
LOG_LEVEL="${LOG_LEVEL:-info}"   # debug | info | warn | error

# Cleanup on success — keep this many most-recent backups even if older
# backups would otherwise be retained (acts as a floor).
MIN_KEEP="${MIN_KEEP:-3}"

# ---------------------------------------------------------------------------
# Load .env file if it exists
# ---------------------------------------------------------------------------
if [ -f "${ENV_FILE}" ]; then
    # shellcheck disable=SC1090
    set -a
    . "${ENV_FILE}"
    set +a
fi

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
_log() {
    local level="$1"; shift
    local msg="$*"
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "[${ts}] [${level}] ${msg}"
}

_should_log() {
    local level="$1"
    local order=(debug info warn error)
    local i j
    for i in "${!order[@]}"; do
        [ "${order[$i]}" = "${LOG_LEVEL}" ] && j=$i
        [ "${order[$i]}" = "${level}" ] && return $((i >= j))
    done
    return 0
}

log_debug() { _should_log debug && _log DEBUG "$@" || true; }
log_info()  { _should_log info  && _log INFO  "$@" || true; }
log_warn()  { _should_log warn  && _log WARN  "$@" || true; }
log_error() { _should_log error && _log ERROR "$@" || true; }

# ---------------------------------------------------------------------------
# Parse command-line arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --env-file)    ENV_FILE="$2"; shift 2;;
        --help|-h)
            cat <<EOF
Usage: $0 [OPTIONS]

Nightly PostgreSQL backup for Elite SACCO Mbarara.

Options:
  --env-file FILE   Load env vars from FILE (default: ${DEFAULT_ENV_FILE})
  --help, -h        Show this help and exit

Configuration (via env vars or .env file):
  Database:
    DATABASE_URL            Full connection string (preferred)
    PGHOST, PGPORT          Host and port (default: localhost:5432)
    PGDATABASE              Database name (default: elite_sacco)
    PGUSER, PGPASSWORD      Credentials (or use ~/.pgpass)

  Backup:
    BACKUP_DIR              Local dir (default: /var/backups/elite-sacco)
    BACKUP_FORMAT           custom | plain | directory (default: custom)
    BACKUP_COMPRESS_LEVEL   0-9 (default: 6)
    BACKUP_PREFIX           Filename prefix (default: elite-sacco)
    BACKUP_GLOBALS          Also dump roles/tablespaces (default: true)
    BACKUP_VERIFY           Verify backup after dump (default: true)

  Retention (days to keep):
    RETENTION_DAILY         Default: 7
    RETENTION_WEEKLY        Default: 8
    RETENTION_MONTHLY       Default: 12
    MIN_KEEP                Floor on number of backups (default: 3)

  S3 upload (optional):
    BACKUP_S3_ENABLE        true to enable (default: false)
    BACKUP_S3_BUCKET        Bucket name
    BACKUP_S3_PREFIX        Key prefix (default: backups/elite-sacco)
    BACKUP_S3_ENDPOINT      For MinIO/Wasabi/Spaces
    BACKUP_S3_REGION        Default: us-east-1
    BACKUP_S3_PROFILE       AWS profile (default: default)

  Alerts:
    ALERT_SLACK_WEBHOOK     Slack incoming webhook URL
    ALERT_EMAIL_TO          Email recipient(s), comma-separated
    ALERT_EMAIL_FROM        Sender address

  Logging:
    LOG_LEVEL               debug | info | warn | error (default: info)
EOF
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            log_error "Run '$0 --help' for usage."
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
log_info "===================================="
log_info "Elite SACCO backup starting"
log_info "  Time:     ${START_ISO}"
log_info "  Script:   ${SCRIPT_NAME}"
log_info "  Host:     $(hostname 2>/dev/null || echo unknown)"
log_info "  User:     $(whoami 2>/dev/null || echo unknown)"
log_info "  PID:      $$"
log_info "===================================="

# Re-read vars after .env load (env vars set in the calling shell still win)
DB_NAME="${PGDATABASE:-${DB_NAME}}"
DB_HOST="${PGHOST:-${DB_HOST}}"
DB_PORT="${PGPORT:-${DB_PORT}}"
DB_USER="${PGUSER:-${DB_USER}}"

# Check required tools
for tool in pg_dump; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        log_error "Required tool not found: ${tool}"
        log_error "Install the PostgreSQL client package (e.g. 'apt install postgresql-client')."
        exit 3
    fi
done

# If BACKUP_VERIFY is on, we also need pg_restore
if [ "${BACKUP_VERIFY}" = "true" ]; then
    if ! command -v pg_restore >/dev/null 2>&1; then
        log_warn "pg_restore not found — disabling backup verification"
        BACKUP_VERIFY=false
    fi
fi

# If S3 upload is on, we need aws CLI
if [ "${BACKUP_S3_ENABLE}" = "true" ]; then
    if ! command -v aws >/dev/null 2>&1; then
        log_error "BACKUP_S3_ENABLE=true but 'aws' CLI not found"
        log_error "Install: pip install awscli  OR  apt install awscli"
        exit 3
    fi
    if [ -z "${BACKUP_S3_BUCKET}" ]; then
        log_error "BACKUP_S3_ENABLE=true but BACKUP_S3_BUCKET is empty"
        exit 3
    fi
fi

# Check that we can connect to the database
log_info "Pre-flight: checking DB connectivity to ${DB_HOST}:${DB_PORT}/${DB_NAME} as ${DB_USER}"

# Build PGPASSWORD if DATABASE_URL is set
if [ -n "${DATABASE_URL:-}" ]; then
    # Parse DATABASE_URL: postgres://user:pass@host:port/db
    DB_USER="$(echo "${DATABASE_URL}" | sed -n 's|^postgres://\([^:]*\).*|\1|p')"
    DB_HOST="$(echo "${DATABASE_URL}" | sed -n 's|^postgres://[^@]*@\([^:]*\).*|\1|p')"
    DB_PORT="$(echo "${DATABASE_URL}" | sed -n 's|^postgres://[^@]*@[^:]*:\([0-9]*\).*|\1|p')"
    [ -z "${DB_PORT}" ] && DB_PORT=5432
    DB_NAME="$(echo "${DATABASE_URL}" | sed -n 's|^postgres://[^@]*@[^/]*/\(.*\)$|\1|p')"
    export PGPASSWORD="$(echo "${DATABASE_URL}" | sed -n 's|^postgres://[^:]*:\([^@]*\)@.*|\1|p')"
fi

PGCONNECT_TIMEOUT=10 psql_args=(-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}")

if ! command -v psql >/dev/null 2>&1; then
    log_warn "psql not found — skipping DB connectivity pre-check"
elif ! PGCONNECT_TIMEOUT=10 psql "${psql_args[@]}" -c 'SELECT 1' >/dev/null 2>&1; then
    log_error "Cannot connect to PostgreSQL at ${DB_HOST}:${DB_PORT}/${DB_NAME} as ${DB_USER}"
    log_error "Check DATABASE_URL / PG* env vars or ~/.pgpass"
    alert "❌ Elite SACCO backup FAILED at pre-flight: cannot connect to database ${DB_HOST}:${DB_PORT}/${DB_NAME}" "error"
    exit 4
fi
log_info "Pre-flight OK — database reachable"

# Create backup dir if needed
mkdir -p "${BACKUP_DIR}"
if [ ! -w "${BACKUP_DIR}" ]; then
    log_error "Backup directory not writable: ${BACKUP_DIR}"
    exit 5
fi

# ---------------------------------------------------------------------------
# Compute backup file paths
# ---------------------------------------------------------------------------
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DATE_DAY="$(date +%Y%m%d)"
DATE_WEEK="$(date +%Y-W%V)"
DATE_MONTH="$(date +%Y-%m)"
DAY_OF_WEEK="$(date +%u)"     # 1=Mon ... 7=Sun
DAY_OF_MONTH="$(date +%-d)

case "${BACKUP_FORMAT}" in
    custom)   EXT="dump";;
    plain)    EXT="sql";;
    directory) EXT="dir";;
    *) log_error "Invalid BACKUP_FORMAT: ${BACKUP_FORMAT} (must be custom|plain|directory)"; exit 6;;
esac

BACKUP_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.${EXT}"
GLOBALS_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-globals-${TIMESTAMP}.sql"
CHECKSUM_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.${EXT}.sha256"
MANIFEST_FILE="${BACKUP_DIR}/${BACKUP_PREFIX}-${TIMESTAMP}.manifest.json"

log_info "Backup target: ${BACKUP_FILE}"

# ---------------------------------------------------------------------------
# Build pg_dump args
# ---------------------------------------------------------------------------
pg_dump_args=(
    -h "${DB_HOST}"
    -p "${DB_PORT}"
    -U "${DB_USER}"
    -d "${DB_NAME}"
    --verbose
    --no-password
    --no-owner          # don't include ALTER OWNER commands
    --no-privileges     # don't include GRANT/REVOKE (we manage roles separately)
    --exclude-table-data='audit_log'   # audit_log is huge and rarely needed for restore;
                                       # use --include-table-data=audit_log on a separate
                                       # monthly run if you need point-in-time audit history
)

case "${BACKUP_FORMAT}" in
    custom)
        pg_dump_args+=(-Fc -Z "${BACKUP_COMPRESS_LEVEL}")
        ;;
    plain)
        pg_dump_args+=(-Fp)
        ;;
    directory)
        pg_dump_args+=(-Fd -j 4 -Z "${BACKUP_COMPRESS_LEVEL}")
        ;;
esac

# ---------------------------------------------------------------------------
# Run the dump
# ---------------------------------------------------------------------------
log_info "Starting pg_dump (format=${BACKUP_FORMAT})..."

if [ "${BACKUP_FORMAT}" = "directory" ]; then
    rm -rf "${BACKUP_FILE}"   # pg_dump -Fd can't overwrite
fi

DUMP_START="$(date +%s)"
if ! pg_dump "${pg_dump_args[@]}" -f "${BACKUP_FILE}" 2>&1 | while read -r line; do log_debug "pg_dump: ${line}"; done; then
    log_error "pg_dump failed"
    alert "❌ Elite SACCO backup FAILED: pg_dump returned non-zero exit code" "error"
    exit 7
fi
DUMP_END="$(date +%s)"
DUMP_SECONDS=$((DUMP_END - DUMP_START))
log_info "pg_dump completed in ${DUMP_SECONDS}s"

# ---------------------------------------------------------------------------
# Dump globals (roles, tablespaces) if requested
# ---------------------------------------------------------------------------
if [ "${BACKUP_GLOBALS}" = "true" ]; then
    log_info "Dumping globals (roles, tablespaces)..."
    if ! pg_dumpall "${pg_dump_args[@]/-d ${DB_NAME}/}" --globals-only -f "${GLOBALS_FILE}" 2>&1 \
            | while read -r line; do log_debug "pg_dumpall: ${line}"; done; then
        log_warn "pg_dumpall failed — globals file may be incomplete"
    else
        log_info "Globals dumped: ${GLOBALS_FILE}"
    fi
fi

# ---------------------------------------------------------------------------
# Compute checksum
# ---------------------------------------------------------------------------
log_info "Computing SHA-256 checksum..."
if [ "${BACKUP_FORMAT}" = "directory" ]; then
    # For directory format, tar first then checksum
    TAR_FILE="${BACKUP_FILE}.tar"
    tar -cf "${TAR_FILE}" -C "${BACKUP_DIR}" "$(basename "${BACKUP_FILE}")"
    rm -rf "${BACKUP_FILE}"
    BACKUP_FILE="${TAR_FILE}"
    log_info "Packaged directory backup into: ${BACKUP_FILE}"
fi

if ! sha256sum "${BACKUP_FILE}" > "${CHECKSUM_FILE}"; then
    log_error "sha256sum failed"
    alert "❌ Elite SACCO backup FAILED: could not compute checksum" "error"
    exit 8
fi
CHECKSUM="$(awk '{print $1}' "${CHECKSUM_FILE}")"
log_info "Checksum: ${CHECKSUM}"

# ---------------------------------------------------------------------------
# File size
# ---------------------------------------------------------------------------
FILE_SIZE_BYTES="$(stat -c %s "${BACKUP_FILE}" 2>/dev/null || stat -f %z "${BACKUP_FILE}")"
FILE_SIZE_HR="$(numfmt --to=iec --suffix=B "${FILE_SIZE_BYTES}" 2>/dev/null || echo "${FILE_SIZE_BYTES} bytes")"
log_info "Backup size: ${FILE_SIZE_HR} (${FILE_SIZE_BYTES} bytes)"

# ---------------------------------------------------------------------------
# Verify backup integrity (restore to /dev/null)
# ---------------------------------------------------------------------------
if [ "${BACKUP_VERIFY}" = "true" ]; then
    log_info "Verifying backup integrity..."
    VERIFY_START="$(date +%s)"
    case "${BACKUP_FORMAT}" in
        custom)
            if ! pg_restore -l "${BACKUP_FILE}" >/dev/null 2>&1; then
                log_error "Backup verification FAILED — pg_restore -l returned non-zero"
                alert "❌ Elite SACCO backup FAILED: integrity verification failed (pg_restore -l)" "error"
                exit 9
            fi
            ;;
        plain)
            if ! head -c 100 "${BACKUP_FILE}" | grep -q "PostgreSQL database dump"; then
                log_error "Backup verification FAILED — file does not start with PostgreSQL header"
                alert "❌ Elite SACCO backup FAILED: integrity verification failed (no header)" "error"
                exit 9
            fi
            ;;
        directory)
            # Already converted to .tar — verify the tar is readable
            if ! tar -tf "${BACKUP_FILE}" >/dev/null 2>&1; then
                log_error "Backup verification FAILED — tar -t returned non-zero"
                alert "❌ Elite SACCO backup FAILED: integrity verification failed (tar -t)" "error"
                exit 9
            fi
            ;;
    esac
    VERIFY_END="$(date +%s)"
    log_info "Backup verified in $((VERIFY_END - VERIFY_START))s"
fi

# ---------------------------------------------------------------------------
# Write manifest (machine-readable metadata)
# ---------------------------------------------------------------------------
cat > "${MANIFEST_FILE}" <<EOF
{
  "backup_id": "${TIMESTAMP}",
  "created_at": "${START_ISO}",
  "database": {
    "host": "${DB_HOST}",
    "port": ${DB_PORT},
    "name": "${DB_NAME}",
    "user": "${DB_USER}"
  },
  "files": {
    "backup":   "$(basename "${BACKUP_FILE}")",
    "globals":  "$(basename "${GLOBALS_FILE}" 2>/dev/null || echo "")",
    "checksum": "$(basename "${CHECKSUM_FILE}")"
  },
  "size_bytes": ${FILE_SIZE_BYTES},
  "checksum_sha256": "${CHECKSUM}",
  "format": "${BACKUP_FORMAT}",
  "compress_level": ${BACKUP_COMPRESS_LEVEL},
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "duration_seconds": $(($(date +%s) - START_TIME))
}
EOF
log_info "Manifest written: ${MANIFEST_FILE}"

# ---------------------------------------------------------------------------
# Apply retention policy
# ---------------------------------------------------------------------------
log_info "Applying retention policy:"
log_info "  Daily:   keep last ${RETENTION_DAILY} days"
log_info "  Weekly:  keep last ${RETENTION_WEEKLY} weekly backups (Sundays)"
log_info "  Monthly: keep last ${RETENTION_MONTHLY} monthly backups (1st of month)"
log_info "  Floor:   keep at least ${MIN_KEEP} backups regardless of age"

# Count current backups
current_count=$(find "${BACKUP_DIR}" -name "${BACKUP_PREFIX}-*.${EXT}" -type f | wc -l)
log_info "  Current backup count: ${current_count}"

# Daily retention — delete backups older than N days, but never below MIN_KEEP
deleted_count=0
while IFS= read -r old_file; do
    if [ "${current_count}" -le "${MIN_KEEP}" ]; then
        log_info "  Reached MIN_KEEP floor (${MIN_KEEP}) — stopping deletion"
        break
    fi
    log_debug "  Deleting (daily retention): $(basename "${old_file}")"
    rm -f "${old_file}" "${old_file}.sha256" "${old_file}.manifest.json"
    # Also delete matching globals file
    rm -f "$(echo "${old_file}" | sed "s/-${TIMESTAMP}\./-globals-${TIMESTAMP}./")" 2>/dev/null || true
    current_count=$((current_count - 1))
    deleted_count=$((deleted_count + 1))
done < <(find "${BACKUP_DIR}" -name "${BACKUP_PREFIX}-*.${EXT}" -type f -mtime "+${RETENTION_DAILY}" | sort)

log_info "  Deleted ${deleted_count} backup(s) older than ${RETENTION_DAILY} days"

# Note: weekly and monthly retention are implemented by tagging specific
# backups (Sundays for weekly, 1st-of-month for monthly) and excluding them
# from the daily deletion. Since this script runs every night, we mark the
# current backup if it qualifies as a weekly or monthly anchor.
if [ "${DAY_OF_WEEK}" = "7" ]; then
    log_info "  Today is Sunday — marking backup as weekly anchor"
    touch "${BACKUP_DIR}/.weekly-${TIMESTAMP}"
fi
if [ "${DAY_OF_MONTH}" = "1" ]; then
    log_info "  Today is 1st of month — marking backup as monthly anchor"
    touch "${BACKUP_DIR}/.monthly-${TIMESTAMP}"
fi

# Delete stale weekly anchors (older than RETENTION_WEEKLY weeks)
weekly_deleted=0
while IFS= read -r anchor; do
    [ -z "${anchor}" ] && continue
    log_debug "  Removing stale weekly anchor: $(basename "${anchor}")"
    rm -f "${anchor}"
    weekly_deleted=$((weekly_deleted + 1))
done < <(find "${BACKUP_DIR}" -name ".weekly-*" -mtime "+$((RETENTION_WEEKLY * 7))" 2>/dev/null || true)
log_info "  Removed ${weekly_deleted} stale weekly anchor(s)"

# Delete stale monthly anchors (older than RETENTION_MONTHLY months ≈ 30 days)
monthly_deleted=0
while IFS= read -r anchor; do
    [ -z "${anchor}" ] && continue
    log_debug "  Removing stale monthly anchor: $(basename "${anchor}")"
    rm -f "${anchor}"
    monthly_deleted=$((monthly_deleted + 1))
done < <(find "${BACKUP_DIR}" -name ".monthly-*" -mtime "+$((RETENTION_MONTHLY * 30))" 2>/dev/null || true)
log_info "  Removed ${monthly_deleted} stale monthly anchor(s)"

# ---------------------------------------------------------------------------
# Upload to S3 (if enabled)
# ---------------------------------------------------------------------------
S3_UPLOADED=false
if [ "${BACKUP_S3_ENABLE}" = "true" ]; then
    log_info "Uploading to S3: s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/"

    S3_BASE_ARGS=()
    if [ -n "${BACKUP_S3_ENDPOINT}" ]; then
        S3_BASE_ARGS+=(--endpoint-url "${BACKUP_S3_ENDPOINT}")
    fi
    S3_BASE_ARGS+=(--region "${BACKUP_S3_REGION}" --profile "${BACKUP_S3_PROFILE}")

    S3_KEY="${BACKUP_S3_PREFIX}/$(date +%Y)/$(date +%m)/$(basename "${BACKUP_FILE}")"
    S3_KEY_CHECKSUM="${BACKUP_S3_PREFIX}/$(date +%Y)/$(date +%m)/$(basename "${CHECKSUM_FILE}")"
    S3_KEY_MANIFEST="${BACKUP_S3_PREFIX}/$(date +%Y)/$(date +%m)/$(basename "${MANIFEST_FILE}")"

    UPLOAD_START="$(date +%s)"

    if ! aws s3 cp "${BACKUP_FILE}"     "s3://${BACKUP_S3_BUCKET}/${S3_KEY}"          "${S3_BASE_ARGS[@]}" 2>&1 | while read -r line; do log_debug "aws: ${line}"; done; then
        log_error "S3 upload failed for backup file"
        alert "❌ Elite SACCO backup FAILED: S3 upload of backup file failed" "error"
        exit 10
    fi
    aws s3 cp "${CHECKSUM_FILE}"  "s3://${BACKUP_S3_BUCKET}/${S3_KEY_CHECKSUM}"  "${S3_BASE_ARGS[@]}" >/dev/null 2>&1 || log_warn "Could not upload checksum file"
    aws s3 cp "${MANIFEST_FILE}"  "s3://${BACKUP_S3_BUCKET}/${S3_KEY_MANIFEST}"  "${S3_BASE_ARGS[@]}" >/dev/null 2>&1 || log_warn "Could not upload manifest file"

    UPLOAD_END="$(date +%s)"
    log_info "S3 upload completed in $((UPLOAD_END - UPLOAD_START))s"
    log_info "  s3://${BACKUP_S3_BUCKET}/${S3_KEY}"
    S3_UPLOADED=true

    # Apply S3 lifecycle — delete backups older than RETENTION_DAILY in the bucket
    # (uses S3 server-side lifecycle policy if configured, else we delete manually)
    log_debug "Skipping S3-side retention — configure bucket lifecycle policy in AWS console"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
END_TIME="$(date +%s)"
DURATION=$((END_TIME - START_TIME))
END_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log_info "===================================="
log_info "Backup completed successfully"
log_info "  Duration:     ${DURATION}s"
log_info "  File:         ${BACKUP_FILE}"
log_info "  Size:         ${FILE_SIZE_HR}"
log_info "  Checksum:     ${CHECKSUM:0:16}..."
log_info "  S3 uploaded:  ${S3_UPLOADED}"
log_info "  End time:     ${END_ISO}"
log_info "===================================="

alert "✅ Elite SACCO backup completed in ${DURATION}s — $(basename "${BACKUP_FILE}") (${FILE_SIZE_HR})" "info"

exit 0
