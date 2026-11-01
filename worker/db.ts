/**
 * MongoDB 접근 계층.
 * 문서 필드는 예전 테이블 열과 같은 이름(snake_case)을 쓰고, 값이 없으면 null을 저장한다.
 * 여러 쓰기를 원자적으로 묶을 때는 `write`로 쓰기를 만들어 `batch`(트랜잭션)에 넘긴다. 트랜잭션에는 복제 세트가 필요하다(Atlas는 기본).
 * 연결은 첫 쿼리 때 맺고 함수 인스턴스 동안 재사용한다.
 */
import { MongoClient, MongoServerError, type ClientSession, type Db, type IndexDescription } from "mongodb";
import type { ActorRole, AuditAction, DriftItem, DriftRepairSummary } from "../shared/schemas";
import type { LockTrigger } from "./services/job-lock";
import type { DnsOpRow } from "./services/dns-ops";
import type { LeaseRow, RecordRow } from "./services/leases";

export interface UserRow {
  email: string;
  idp_sub: string;
  name: string | null;
  sohakoe_memberships: unknown[];
  first_login_at: number;
  last_login_at: number;
  banned_at: number | null;
  ban_reason: string | null;
}

export interface SessionRow {
  id_hash: string;
  email: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
}

export interface AuditRow {
  at: number;
  actor_email: string | null;
  actor_role: ActorRole;
  action: AuditAction;
  lease_id: string | null;
  target_email: string | null;
  detail: unknown;
  ip: string | null;
  user_agent: string | null;
}

export interface ReconcileRunRow {
  at: number;
  ok: number;
  drift_count: number;
  items: DriftItem[];
  error: string | null;
  repaired: DriftRepairSummary | null;
  /** 시드가 넣은 문서 표시 */
  seed?: boolean;
}

export interface JobLockRow {
  name: string;
  started_at: number;
  trigger: LockTrigger;
}

/** 조회 결과에서 `_id`를 뺀다. 공개 id가 따로 있는 컬렉션에 쓴다. */
export const NO_ID = { projection: { _id: 0 } } as const;

interface WriteOutcome {
  deletedCount?: number;
  matchedCount?: number;
  upsertedCount?: number;
  insertedId?: unknown;
}

/** 영향받은 문서 수 */
function changes(r: WriteOutcome): number {
  if (r.insertedId !== undefined) return 1;
  return r.deletedCount ?? (r.matchedCount ?? 0) + (r.upsertedCount ?? 0);
}

/** 아직 실행하지 않은 쓰기. `run`으로 바로 실행하거나 `batch`에 넣는다. 트랜잭션 재시도로 다시 실행될 수 있다. */
export class Write {
  constructor(private readonly exec: (session?: ClientSession) => Promise<WriteOutcome>) {}

  async run(session?: ClientSession): Promise<number> {
    return changes(await this.exec(session));
  }
}

export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/** 컬렉션별 인덱스. `pnpm run db:migrate`가 적용한다. */
export const INDEXES: Record<string, IndexDescription[]> = {
  users: [
    { key: { email: 1 }, unique: true },
    { key: { idp_sub: 1 }, unique: true },
  ],
  sessions: [{ key: { id_hash: 1 }, unique: true }, { key: { email: 1 } }],
  leases: [
    { key: { id: 1 }, unique: true },
    // 같은 이름은 active/suspended 상태로 하나만 존재
    { key: { name: 1 }, name: "uq_leases_name_live", unique: true, partialFilterExpression: { status: { $in: ["active", "suspended"] } } },
    { key: { name: 1, status: 1 } },
    { key: { owner_email: 1 } },
    { key: { status: 1, last_health_check_at: 1 } },
  ],
  records: [{ key: { id: 1 }, unique: true }, { key: { lease_id: 1 } }],
  audit_logs: [{ key: { at: -1 } }, { key: { lease_id: 1 } }, { key: { actor_email: 1 } }],
  reconcile_runs: [{ key: { at: -1 } }],
  dns_ops: [{ key: { id: 1 }, unique: true }, { key: { started_at: 1 } }, { key: { lease_id: 1 } }],
  job_locks: [{ key: { name: 1 }, unique: true }],
};

export class Database {
  private client: MongoClient | undefined;

  constructor(
    private readonly uri: string,
    private readonly name: string,
  ) {}

  private connection(): MongoClient {
    return (this.client ??= new MongoClient(this.uri, { ignoreUndefined: true, serverSelectionTimeoutMS: 5000 }));
  }

  private get db(): Db {
    return this.connection().db(this.name);
  }

  get users() {
    return this.db.collection<UserRow>("users");
  }
  get sessions() {
    return this.db.collection<SessionRow>("sessions");
  }
  get leases() {
    return this.db.collection<LeaseRow>("leases");
  }
  get records() {
    return this.db.collection<RecordRow>("records");
  }
  get auditLogs() {
    return this.db.collection<AuditRow>("audit_logs");
  }
  get reconcileRuns() {
    return this.db.collection<ReconcileRunRow>("reconcile_runs");
  }
  get dnsOps() {
    return this.db.collection<DnsOpRow>("dns_ops");
  }
  get jobLocks() {
    return this.db.collection<JobLockRow>("job_locks");
  }

  write(exec: (session?: ClientSession) => Promise<WriteOutcome>): Write {
    return new Write(exec);
  }

  /** 쓰기들을 하나의 트랜잭션으로 실행한다. 하나라도 실패하면 전부 롤백된다. 쓰기별 영향받은 문서 수를 돌려준다. */
  async batch(writes: readonly Write[]): Promise<number[]> {
    if (writes.length === 0) return [];
    const session = this.connection().startSession();
    try {
      return await session.withTransaction(async () => {
        const counts: number[] = [];
        for (const write of writes) counts.push(await write.run(session));
        return counts;
      });
    } finally {
      await session.endSession();
    }
  }

  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  async ensureIndexes(): Promise<string[]> {
    const applied: string[] = [];
    for (const [collection, indexes] of Object.entries(INDEXES)) {
      await this.db.collection(collection).createIndexes(indexes);
      applied.push(collection);
    }
    return applied;
  }

  /** 로컬 초기화용(scripts/reset-local-db.ts). 없는 컬렉션은 무시한다. */
  async dropCollections(names: readonly string[]): Promise<void> {
    for (const name of names) await this.db.collection(name).drop();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

export function openDatabase(uri: string, name: string): Database {
  return new Database(uri, name);
}
