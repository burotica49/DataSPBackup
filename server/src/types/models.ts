export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  created_at: string;
}

export interface DatabaseSource {
  id: number;
  name: string;
  engine: string;
  host: string;
  port: number;
  db_name: string;
  username: string;
  password_enc: string;
  ssl_mode: string;
  included_schemas: string; // JSON array ; [] = tous
  excluded_tables: string; // JSON array — --exclude-table
  excluded_table_data: string; // JSON array — --exclude-table-data
  ignore_user_mappings: number;
  is_supabase: number;
  pg_major: number | null;
  /** Chaîne VERSION() pour MySQL / MariaDB. */
  server_version: string | null;
  group_id: number | null;
  /** Surveillance de disponibilité (0/1 et paramètres). */
  avail_enabled: number;
  avail_notify: number;
  avail_interval_min: number;
  avail_attempts: number;
  avail_history_days: number;
  avail_fail_streak: number;
  avail_down: number;
  avail_last_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AvailabilityCheck {
  id: number;
  database_id: number;
  ok: number;
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
}

export interface DbGroup {
  id: number;
  name: string;
  created_at: string;
}

export interface Storage {
  id: number;
  name: string;
  type: "local" | "s3";
  config_enc: string;
  created_at: string;
}

export interface BackupPolicy {
  id: number;
  database_id: number;
  storage_id: number;
  schedule_cron: string;
  retention_count: number | null;
  retention_days: number | null;
  compression: "none" | "gzip" | "zstd";
  encrypt: number;
  verify_after: number;
  notify_success: number;
  notify_failure: number;
  enabled: number;
  created_at: string;
}

export type BackupStatus = "pending" | "running" | "success" | "failed";

export interface Backup {
  id: number;
  database_id: number;
  policy_id: number | null;
  storage_id: number | null;
  status: BackupStatus;
  trigger: "manual" | "schedule";
  started_at: string | null;
  finished_at: string | null;
  size_bytes: number | null;
  file_path: string | null;
  encrypted: number;
  pg_major: number | null;
  server_version: string | null;
  schemas_json: string | null;
  checksum: string | null;
  error: string | null;
  created_at: string;
}

export type VerificationStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "canceled";

export interface Verification {
  id: number;
  backup_id: number;
  database_id: number;
  status: VerificationStatus;
  trigger: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  restored_size_bytes: number | null;
  schema_count: number | null;
  table_count: number | null;
  row_counts_json: string | null;
  errors_json: string | null;
  root_error: string | null;
  report_json: string | null;
  created_at: string;
}

export interface Restore {
  id: number;
  backup_id: number;
  mode: "existing" | "new";
  target_label: string;
  status: "pending" | "running" | "success" | "failed";
  exit_code: number | null;
  root_error: string | null;
  errors_json: string | null;
  report_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export type NotificationType = "telegram" | "email" | "webhook";

export interface NotificationChannel {
  id: number;
  type: NotificationType;
  name: string;
  config_enc: string;
  on_start: number;
  on_success: number;
  on_failure: number;
  enabled: number;
  created_at: string;
}

export type NotifyEvent = "start" | "success" | "failure";

/** Erreur de restauration catégorisée (voir services/verify/errors.ts). */
export interface CategorizedError {
  category: string;
  count: number;
  sample: string;
  hint: string;
  blocking: boolean;
}
