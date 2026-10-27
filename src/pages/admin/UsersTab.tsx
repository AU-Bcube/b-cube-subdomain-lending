import {
  Button,
  DataTableSkeleton,
  InlineNotification,
  Search,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
} from "@carbon/react";
import { useState } from "react";
import type { AdminUserItem } from "../../../shared/schemas";
import { adminApi } from "../../api/admin";
import { KoPagination } from "../../components/KoPagination";
import { ReasonModal } from "../../components/ReasonModal";
import { useToast } from "../../components/Toasts";
import { formatDateTime } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { useDebounced } from "../../lib/useDebounced";
import { useSession } from "../../session";

const HEADERS = ["이메일", "이름", "보유 (사용 중 / 전체)", "마지막 로그인", "상태", "작업"];

type Pending = { kind: "ban" | "unban"; user: AdminUserItem };

export function UsersTab() {
  const { me } = useSession();
  const notify = useToast();
  const [q, setQ] = useState("");
  const [banned, setBanned] = useState("");
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Pending | null>(null);
  const query = useDebounced(q.trim());
  const { data, loading, error, reload } = useAsync(() => adminApi.users({ q: query, banned, page }), [query, banned, page]);

  return (
    <div className="admin-tab">
      <TableContainer title="사용자" description="차단하면 해당 사용자의 세션이 모두 끊기고, 사용 중·일시 중지 상태의 서브도메인이 회수됩니다.">
        <TableToolbar aria-label="사용자 검색">
          <TableToolbarContent className="admin-toolbar">
            <Search
              labelText="검색"
              placeholder="이메일 또는 이름"
              size="lg"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
            <Select
              id="user-banned-filter"
              labelText="차단 여부"
              hideLabel
              inline
              value={banned}
              onChange={(e) => {
                setBanned(e.target.value);
                setPage(1);
              }}
            >
              <SelectItem value="" text="전체" />
              <SelectItem value="false" text="정상" />
              <SelectItem value="true" text="차단됨" />
            </Select>
          </TableToolbarContent>
        </TableToolbar>
        {error && <InlineNotification kind="error" title="불러오지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
        {loading && !data ? (
          <DataTableSkeleton headers={HEADERS.map((header) => ({ header }))} columnCount={HEADERS.length} rowCount={5} showHeader={false} showToolbar={false} />
        ) : (
          <div className="table-scroll">
            <Table size="md" aria-label="사용자 목록">
              <TableHead>
                <TableRow>
                  {HEADERS.map((h) => (
                    <TableHeader key={h}>{h}</TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data?.items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={HEADERS.length}>조건에 맞는 사용자가 없습니다.</TableCell>
                  </TableRow>
                )}
                {data?.items.map((user) => (
                  <TableRow key={user.email}>
                    <TableCell>
                      {user.email}
                      {user.isAdmin && (
                        <Tag type="blue" size="sm" className="inline-tag">
                          관리자
                        </Tag>
                      )}
                    </TableCell>
                    <TableCell>{user.name ?? "-"}</TableCell>
                    <TableCell>
                      {user.liveLeaseCount} / {user.totalLeaseCount}
                    </TableCell>
                    <TableCell>{formatDateTime(user.lastLoginAt)}</TableCell>
                    <TableCell>
                      {user.bannedAt ? (
                        <>
                          <Tag type="red" size="sm">
                            차단됨
                          </Tag>
                          <div className="cell-sub">
                            {formatDateTime(user.bannedAt)} · {user.banReason}
                          </div>
                        </>
                      ) : (
                        <Tag type="green" size="sm">
                          정상
                        </Tag>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.bannedAt ? (
                        <Button kind="ghost" size="sm" onClick={() => setPending({ kind: "unban", user })}>
                          차단 해제
                        </Button>
                      ) : (
                        user.email !== me?.email && (
                          <Button kind="danger--ghost" size="sm" onClick={() => setPending({ kind: "ban", user })}>
                            차단
                          </Button>
                        )
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data && data.total > 0 && <KoPagination page={page} pageSize={data.pageSize} totalItems={data.total} onChange={setPage} />}
      </TableContainer>

      <ReasonModal
        open={pending?.kind === "ban"}
        danger
        heading="사용자 차단"
        primaryText="차단"
        onClose={() => setPending(null)}
        onSubmit={async (reason) => {
          if (!pending) return;
          const result = await adminApi.ban(pending.user.email, reason);
          if (result.failedLeases.length > 0) {
            notify("warning", "차단했지만 일부 서브도메인을 회수하지 못했습니다", result.failedLeases.join(", "));
          } else {
            notify("success", "차단했습니다", `${pending.user.email} · 회수 ${result.revokedLeases.length}개`);
          }
          reload();
        }}
      >
        {pending?.kind === "ban" && (
          <p>
            <strong>{pending.user.email}</strong>을(를) 차단합니다. 모든 세션이 즉시 끊기고, 사용 중·일시 중지 상태의 서브도메인{" "}
            {pending.user.liveLeaseCount}개가 회수됩니다(사유: 사용자 차단). 차단을 해제해도 회수한 서브도메인은 복구되지 않습니다.
          </p>
        )}
      </ReasonModal>

      <ReasonModal
        open={pending?.kind === "unban"}
        heading="차단 해제"
        primaryText="차단 해제"
        required={false}
        onClose={() => setPending(null)}
        onSubmit={async (reason) => {
          if (!pending) return;
          await adminApi.unban(pending.user.email, reason);
          notify("success", "차단을 해제했습니다", pending.user.email);
          reload();
        }}
      >
        {pending?.kind === "unban" && (
          <p>
            <strong>{pending.user.email}</strong>의 차단을 해제합니다. 차단 사유: {pending.user.banReason ?? "-"}
            <br />
            회수된 서브도메인은 복구되지 않습니다.
          </p>
        )}
      </ReasonModal>
    </div>
  );
}
