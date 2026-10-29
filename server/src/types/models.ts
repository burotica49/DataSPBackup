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
  included_schemas: string; // JSON array
  is_supabase: number;
  pg_major: number | null;
  created_at: string;
  updated_at: string;
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
