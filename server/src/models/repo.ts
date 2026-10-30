import { getDb } from "../db/index.js";
import type {
  Backup,
  BackupPolicy,
  BackupStatus,
  DatabaseSource,
  DbGroup,
  NotificationChannel,
  Restore,
  Storage,
  User,
  Verification,
  VerificationStatus,
  AvailabilityCheck,
} from "../types/models.js";

/** Accès typé aux métadonnées. Toutes les écritures passent par ici. */

// --- Users -----------------------------------------------------------------
export const users = {
  findByEmail(email: string): User | undefined {
    return getDb()
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email) as User | undefined;
  },
  count(): number {
    return (
      getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
    ).n;
  },
  create(email: string, passwordHash: string, role = "owner"): User {
    const info = getDb()
      .prepare(
        "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
      )
      .run(email, passwordHash, role);
    return getDb()
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(info.lastInsertRowid) as User;
  },
};

// --- Databases -------------------------------------------------------------
export const databases = {
  list(): DatabaseSource[] {
    return getDb()
      .prepare("SELECT * FROM databases ORDER BY name")
      .all() as DatabaseSource[];
  },
  get(id: number): DatabaseSource | undefined {
    return getDb()
      .prepare("SELECT * FROM databases WHERE id = ?")
      .get(id) as DatabaseSource | undefined;
  },
  create(d: Partial<DatabaseSource>): DatabaseSource {
    const info = getDb()
      .prepare(
        `INSERT INTO databases
          (name, engine, host, port, db_name, username, password_enc,
           ssl_mode, included_schemas, excluded_tables, excluded_table_data,
           ignore_user_mappings, is_supabase, group_id)
         VALUES (@name, @engine, @host, @port, @db_name, @username,
                 @password_enc, @ssl_mode, @included_schemas, @excluded_tables,
                 @excluded_table_data, @ignore_user_mappings, @is_supabase,
                 @group_id)`,
      )
      .run({
        name: d.name,
        engine: d.engine ?? "postgres",
        host: d.host,
        port: d.port ?? 5432,
        db_name: d.db_name,
        username: d.username,
        password_enc: d.password_enc,
        ssl_mode: d.ssl_mode ?? "prefer",
        included_schemas: d.included_schemas ?? "[]",
        excluded_tables: d.excluded_tables ?? "[]",
        excluded_table_data: d.excluded_table_data ?? "[]",
        ignore_user_mappings: d.ignore_user_mappings ?? 0,
        is_supabase: d.is_supabase ?? 0,
        group_id: d.group_id ?? null,
      });
    return this.get(Number(info.lastInsertRowid))!;
  },
  setPgMajor(id: number, major: number): void {
    getDb()
      .prepare(
        "UPDATE databases SET pg_major = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(major, id);
  },
  setServerVersion(id: number, version: string): void {
    getDb()
      .prepare(
        "UPDATE databases SET server_version = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(version, id);
  },
  update(id: number, patch: Partial<DatabaseSource>): void {
    const allowed = [
      "name",
      "host",
      "port",
      "db_name",
      "username",
      "password_enc",
      "ssl_mode",
      "included_schemas",
      "excluded_tables",
      "excluded_table_data",
      "ignore_user_mappings",
      "is_supabase",
      "group_id",
      "avail_enabled",
      "avail_notify",
      "avail_interval_min",
      "avail_attempts",
      "avail_history_days",
      "avail_fail_streak",
      "avail_down",
      "avail_last_check_at",
    ] as const;
    const keys = allowed.filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    const values: Record<string, unknown> = { id };
    for (const k of keys) values[k] = patch[k];
    getDb()
      .prepare(
        `UPDATE databases SET ${set}, updated_at = datetime('now') WHERE id = @id`,
      )
      .run(values);
  },
  remove(id: number): void {
    getDb().prepare("DELETE FROM databases WHERE id = ?").run(id);
  },
};

// --- Disponibilité ---------------------------------------------------------
export const availability = {
  insert(row: Omit<AvailabilityCheck, "id">): AvailabilityCheck {
    const info = getDb()
      .prepare(
        `INSERT INTO availability_checks
          (database_id, ok, latency_ms, error, checked_at)
         VALUES (@database_id, @ok, @latency_ms, @error, @checked_at)`,
      )
      .run(row);
    return getDb()
      .prepare("SELECT * FROM availability_checks WHERE id = ?")
      .get(info.lastInsertRowid) as AvailabilityCheck;
  },
  listSince(databaseId: number, sinceIso: string): AvailabilityCheck[] {
    return getDb()
      .prepare(
        `SELECT * FROM availability_checks
         WHERE database_id = ? AND checked_at >= ?
         ORDER BY checked_at ASC
         LIMIT 20000`,
      )
      .all(databaseId, sinceIso) as AvailabilityCheck[];
  },
  purge(databaseId: number, historyDays: number): void {
    const days = Math.max(1, Math.min(365, Math.trunc(historyDays) || 7));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    getDb()
      .prepare(
        "DELETE FROM availability_checks WHERE database_id = ? AND checked_at < ?",
      )
      .run(databaseId, cutoff);
  },
};

// --- Groupes (dossiers de la liste) ----------------------------------------
function sameGroupName(a: string, b: string): boolean {
  return a.localeCompare(b, "fr", { sensitivity: "accent" }) === 0;
}

export const groups = {
  list(): DbGroup[] {
    return getDb()
      .prepare("SELECT * FROM db_groups ORDER BY position, name")
      .all() as DbGroup[];
  },
  get(id: number): DbGroup | undefined {
    return getDb()
      .prepare("SELECT * FROM db_groups WHERE id = ?")
      .get(id) as DbGroup | undefined;
  },
  nameTaken(name: string, exceptId?: number): boolean {
    return this.list().some(
      (g) => g.id !== exceptId && sameGroupName(g.name, name),
    );
  },
  create(name: string): DbGroup {
    const next = getDb()
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM db_groups")
      .get() as { p: number };
    const info = getDb()
      .prepare("INSERT INTO db_groups (name, position) VALUES (?, ?)")
      .run(name, next.p);
    return this.get(Number(info.lastInsertRowid))!;
  },
  /** Réécrit l'ordre. `ids` doit contenir chaque groupe une seule fois. */
  reorder(ids: number[]): boolean {
    const existing = this.list().map((g) => g.id);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length) return false;
    const known = new Set(existing);
    if (!ids.every((id) => known.has(id))) return false;
    const tx = getDb().transaction(() => {
      const stmt = getDb().prepare("UPDATE db_groups SET position = ? WHERE id = ?");
      ids.forEach((id, index) => stmt.run(index, id));
    });
    tx();
    return true;
  },
  rename(id: number, name: string): void {
    getDb().prepare("UPDATE db_groups SET name = ? WHERE id = ?").run(name, id);
  },
  /** Supprime le dossier. Les bases qu'il contient restent, sans groupe. */
  remove(id: number): void {
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          "UPDATE databases SET group_id = NULL, updated_at = datetime('now') WHERE group_id = ?",
        )
        .run(id);
      getDb().prepare("DELETE FROM db_groups WHERE id = ?").run(id);
    });
    tx();
  },
};

// --- Storages --------------------------------------------------------------
export const storages = {
  list(): Storage[] {
    return getDb()
      .prepare("SELECT * FROM storages ORDER BY name")
      .all() as Storage[];
  },
  get(id: number): Storage | undefined {
    return getDb()
      .prepare("SELECT * FROM storages WHERE id = ?")
      .get(id) as Storage | undefined;
  },
  create(s: Partial<Storage>): Storage {
    const info = getDb()
      .prepare(
        "INSERT INTO storages (name, type, config_enc) VALUES (?, ?, ?)",
      )
      .run(s.name, s.type, s.config_enc ?? "");
    return this.get(Number(info.lastInsertRowid))!;
  },
};

// --- Backup policies -------------------------------------------------------
export const policies = {
  list(): BackupPolicy[] {
    return getDb()
      .prepare("SELECT * FROM backup_policies ORDER BY id")
      .all() as BackupPolicy[];
  },
  get(id: number): BackupPolicy | undefined {
    return getDb()
      .prepare("SELECT * FROM backup_policies WHERE id = ?")
      .get(id) as BackupPolicy | undefined;
  },
  create(p: Partial<BackupPolicy>): BackupPolicy {
    const info = getDb()
      .prepare(
        `INSERT INTO backup_policies
          (database_id, storage_id, schedule_cron, retention_count,
           retention_days, compression, encrypt, verify_after,
           notify_success, notify_failure, enabled)
         VALUES (@database_id, @storage_id, @schedule_cron, @retention_count,
                 @retention_days, @compression, @encrypt, @verify_after,
                 @notify_success, @notify_failure, @enabled)`,
      )
      .run({
        database_id: p.database_id,
        storage_id: p.storage_id,
        schedule_cron: p.schedule_cron,
        retention_count: p.retention_count ?? null,
        retention_days: p.retention_days ?? null,
        compression: p.compression ?? "zstd",
        encrypt: p.encrypt ?? 1,
        verify_after: p.verify_after ?? 1,
        notify_success: p.notify_success ?? 0,
        notify_failure: p.notify_failure ?? 1,
        enabled: p.enabled ?? 1,
      });
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<BackupPolicy>): void {
    const allowed = [
      "storage_id",
      "schedule_cron",
      "retention_count",
      "retention_days",
      "compression",
      "encrypt",
      "verify_after",
      "notify_success",
      "notify_failure",
      "enabled",
    ] as const;
    const keys = allowed.filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    const values: Record<string, unknown> = { id };
    for (const k of keys) values[k] = patch[k];
    getDb()
      .prepare(`UPDATE backup_policies SET ${set} WHERE id = @id`)
      .run(values);
  },
  remove(id: number): void {
    getDb().prepare("DELETE FROM backup_policies WHERE id = ?").run(id);
  },
};

// --- Backups ---------------------------------------------------------------
export const backups = {
  list(databaseId?: number): Backup[] {
    if (databaseId != null) {
      return getDb()
        .prepare(
          "SELECT * FROM backups WHERE database_id = ? ORDER BY created_at DESC",
        )
        .all(databaseId) as Backup[];
    }
    return getDb()
      .prepare("SELECT * FROM backups ORDER BY created_at DESC")
      .all() as Backup[];
  },
  get(id: number): Backup | undefined {
    return getDb()
      .prepare("SELECT * FROM backups WHERE id = ?")
      .get(id) as Backup | undefined;
  },
  create(databaseId: number, trigger: "manual" | "schedule"): Backup {
    const info = getDb()
      .prepare(
        "INSERT INTO backups (database_id, status, trigger) VALUES (?, 'pending', ?)",
      )
      .run(databaseId, trigger);
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<Backup>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    getDb()
      .prepare(`UPDATE backups SET ${set} WHERE id = @id`)
      .run({ ...patch, id });
  },
  markStatus(id: number, status: BackupStatus): void {
    this.update(id, { status });
  },
  /** Sauvegardes réussies d'une politique, de la plus récente à la plus ancienne. */
  successfulByPolicy(policyId: number): Backup[] {
    return getDb()
      .prepare(
        "SELECT * FROM backups WHERE policy_id = ? AND status = 'success' ORDER BY created_at DESC",
      )
      .all(policyId) as Backup[];
  },
  remove(id: number): void {
    getDb().prepare("DELETE FROM backups WHERE id = ?").run(id);
  },
};

// --- Verifications ---------------------------------------------------------
export const verifications = {
  list(filter?: { backupId?: number; databaseId?: number }): Verification[] {
    if (filter?.backupId != null) {
      return getDb()
        .prepare(
          "SELECT * FROM verifications WHERE backup_id = ? ORDER BY created_at DESC",
        )
        .all(filter.backupId) as Verification[];
    }
    if (filter?.databaseId != null) {
      return getDb()
        .prepare(
          "SELECT * FROM verifications WHERE database_id = ? ORDER BY created_at DESC",
        )
        .all(filter.databaseId) as Verification[];
    }
    return getDb()
      .prepare("SELECT * FROM verifications ORDER BY created_at DESC")
      .all() as Verification[];
  },
  get(id: number): Verification | undefined {
    return getDb()
      .prepare("SELECT * FROM verifications WHERE id = ?")
      .get(id) as Verification | undefined;
  },
  create(backupId: number, databaseId: number, trigger: string): Verification {
    const info = getDb()
      .prepare(
        "INSERT INTO verifications (backup_id, database_id, status, trigger) VALUES (?, ?, 'pending', ?)",
      )
      .run(backupId, databaseId, trigger);
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<Verification>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    getDb()
      .prepare(`UPDATE verifications SET ${set} WHERE id = @id`)
      .run({ ...patch, id });
  },
  markStatus(id: number, status: VerificationStatus): void {
    this.update(id, { status });
  },
};

// --- Restores --------------------------------------------------------------
export const restores = {
  list(backupId?: number): Restore[] {
    if (backupId != null) {
      return getDb()
        .prepare("SELECT * FROM restores WHERE backup_id = ? ORDER BY created_at DESC")
        .all(backupId) as Restore[];
    }
    return getDb()
      .prepare("SELECT * FROM restores ORDER BY created_at DESC")
      .all() as Restore[];
  },
  get(id: number): Restore | undefined {
    return getDb()
      .prepare("SELECT * FROM restores WHERE id = ?")
      .get(id) as Restore | undefined;
  },
  create(backupId: number, mode: string, targetLabel: string): Restore {
    const info = getDb()
      .prepare(
        "INSERT INTO restores (backup_id, mode, target_label, status) VALUES (?, ?, ?, 'pending')",
      )
      .run(backupId, mode, targetLabel);
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<Restore>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    getDb().prepare(`UPDATE restores SET ${set} WHERE id = @id`).run({ ...patch, id });
  },
};

// --- Settings (clé/valeur) -------------------------------------------------
export const settings = {
  get(key: string): string | undefined {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  },
  set(key: string, value: string): void {
    getDb()
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  },
};

// --- Notification channels -------------------------------------------------
export const channels = {
  list(): NotificationChannel[] {
    return getDb()
      .prepare("SELECT * FROM notification_channels ORDER BY name")
      .all() as NotificationChannel[];
  },
  listEnabled(): NotificationChannel[] {
    return getDb()
      .prepare("SELECT * FROM notification_channels WHERE enabled = 1")
      .all() as NotificationChannel[];
  },
  get(id: number): NotificationChannel | undefined {
    return getDb()
      .prepare("SELECT * FROM notification_channels WHERE id = ?")
      .get(id) as NotificationChannel | undefined;
  },
  create(c: Partial<NotificationChannel>): NotificationChannel {
    const info = getDb()
      .prepare(
        `INSERT INTO notification_channels
          (type, name, config_enc, on_start, on_success, on_failure, enabled)
         VALUES (@type, @name, @config_enc, @on_start, @on_success, @on_failure, @enabled)`,
      )
      .run({
        type: c.type,
        name: c.name,
        config_enc: c.config_enc ?? "",
        on_start: c.on_start ?? 0,
        on_success: c.on_success ?? 0,
        on_failure: c.on_failure ?? 1,
        enabled: c.enabled ?? 1,
      });
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<NotificationChannel>): void {
    const allowed = [
      "name",
      "config_enc",
      "on_start",
      "on_success",
      "on_failure",
      "enabled",
    ] as const;
    const keys = allowed.filter((k) => patch[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    const values: Record<string, unknown> = { id };
    for (const k of keys) values[k] = patch[k];
    getDb()
      .prepare(`UPDATE notification_channels SET ${set} WHERE id = @id`)
      .run(values);
  },
  remove(id: number): void {
    getDb().prepare("DELETE FROM notification_channels WHERE id = ?").run(id);
  },
};
