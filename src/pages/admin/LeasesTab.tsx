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
import { LEASE_STATUSES } from "../../../shared/rules";
import type { AdminLeaseItem } from "../../../shared/schemas";
import { adminApi } from "../../api/admin";
import { KoPagination } from "../../components/KoPagination";
import { ReasonModal } from "../../components/ReasonModal";
import { useToast } from "../../components/Toasts";
import { formatDate } from "../../lib/format";
import { LEASE_STATUS_LABELS, STATUS_REASON_LABELS, TARGET_KIND_LABELS } from "../../lib/labels";
import { useAsync } from "../../lib/useAsync";
import { useDebounced } from "../../lib/useDebounced";
import { useSession } from "../../session";

const HEADERS = ["서브도메인", "소유자", "대상", "상태", "레코드", "만료·종료", "작업"];

export function LeasesTab() {
  const { me } = useSession();
  const notify = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [revoking, setRevoking] = useState<AdminLeaseItem | null>(null);
  const query = useDebounced(q.trim());
  const { data, loading, error, reload } = useAsync(() => adminApi.leases({ q: query, status, page }), [query, status, page]);
  const zone = me?.zone ?? "";

  return (
    <div className="admin-tab">
      <TableContainer title="전체 임대" description="이름이나 소유자 이메일로 검색합니다. 사용 중·일시 중지 상태만 강제 회수할 수 있습니다.">
        <TableToolbar aria-label="임대 검색">
          <TableToolbarContent className="admin-toolbar">
            <Search
              labelText="검색"
              placeholder="이름 또는 소유자 이메일"
              size="lg"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
            <Select
              id="lease-status-filter"
              labelText="상태"
              hideLabel
              inline
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <SelectItem value="" text="모든 상태" />
              {LEASE_STATUSES.map((s) => (
                <SelectItem key={s} value={s} text={LEASE_STATUS_LABELS[s].text} />
              ))}
            </Select>
          </TableToolbarContent>
        </TableToolbar>
        {error && <InlineNotification kind="error" title="불러오지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
        {loading && !data ? (
          <DataTableSkeleton headers={HEADERS.map((header) => ({ header }))} columnCount={HEADERS.length} rowCount={5} showHeader={false} showToolbar={false} />
        ) : (
          <div className="table-scroll">
            <Table size="md" aria-label="전체 임대 목록">
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
                    <TableCell colSpan={HEADERS.length}>조건에 맞는 임대가 없습니다.</TableCell>
                  </TableRow>
                )}
                {data?.items.map((lease) => {
                  const st = LEASE_STATUS_LABELS[lease.status];
                  const live = lease.status === "active" || lease.status === "suspended";
                  return (
                    <TableRow key={lease.id}>
                      <TableCell>
                        <span className="mono">
                          {lease.name}.{zone}
                        </span>
                      </TableCell>
                      <TableCell>{lease.ownerEmail}</TableCell>
                      <TableCell>{TARGET_KIND_LABELS[lease.targetKind]}</TableCell>
                      <TableCell>
                        <Tag type={st.tag} size="sm">
                          {st.text}
                        </Tag>
                        {lease.statusReason && (
                          <div className="cell-sub">{STATUS_REASON_LABELS[lease.statusReason] ?? lease.statusReason}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <ul className="record-list">
                          {lease.records.map((r) => (
                            <li key={r.id} className={r.live ? undefined : "record-off"} title={r.live ? undefined : "Cloudflare에 없음"}>
                              <span className="record-type">{r.type}</span> <span className="mono">{r.content}</span>
                              {r.proxied && " (프록시)"}
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell>{live ? formatDate(lease.expiresAt) : formatDate(lease.endedAt)}</TableCell>
                      <TableCell>
                        {live && (
                          <Button kind="danger--ghost" size="sm" onClick={() => setRevoking(lease)}>
                            강제 회수
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {data && data.total > 0 && <KoPagination page={page} pageSize={data.pageSize} totalItems={data.total} onChange={setPage} />}
      </TableContainer>

      <ReasonModal
        open={revoking !== null}
        danger
        heading="서브도메인 강제 회수"
        primaryText="강제 회수"
        onClose={() => setRevoking(null)}
        onSubmit={async (reason) => {
          if (!revoking) return;
          await adminApi.revoke(revoking.id, reason);
          notify("success", "회수했습니다", `${revoking.name}.${zone}`);
          reload();
        }}
      >
        {revoking && (
          <p>
            <strong className="mono">
              {revoking.name}.{zone}
            </strong>
            ({revoking.ownerEmail})의 DNS 레코드를 Cloudflare에서 삭제하고 회수합니다. 회수한 이름은 보류 기간 동안 누구도 신청할 수 없습니다.
          </p>
        )}
      </ReasonModal>
    </div>
  );
}
