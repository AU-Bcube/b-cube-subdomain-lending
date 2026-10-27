import {
  DataTableSkeleton,
  InlineNotification,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from "@carbon/react";
import { Fragment, useState } from "react";
import { AUDIT_ACTIONS } from "../../../shared/schemas";
import { adminApi } from "../../api/admin";
import { KoPagination } from "../../components/KoPagination";
import { dateInputToMs, formatDateTime } from "../../lib/format";
import { ACTOR_ROLE_LABELS, AUDIT_ACTION_LABELS } from "../../lib/labels";
import { useAsync } from "../../lib/useAsync";
import { useDebounced } from "../../lib/useDebounced";

const HEADERS = ["시각", "작업자", "액션", "lease", "대상", "IP"];

export function AuditLogsTab() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [lease, setLease] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const actorQ = useDebounced(actor.trim());
  const leaseQ = useDebounced(lease.trim());
  const { data, loading, error } = useAsync(
    () =>
      adminApi.auditLogs({
        actor: actorQ,
        action,
        lease: leaseQ,
        from: dateInputToMs(from),
        to: dateInputToMs(to, 1), // 종료일 하루 전체 포함
        page,
      }),
    [actorQ, action, leaseQ, from, to, page],
  );

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="admin-tab">
      <TableContainer title="감사 로그" description="모든 상태 변경 기록입니다. 행을 펼치면 변경 전·후 값을 볼 수 있습니다.">
        <div className="audit-filters">
          <TextInput
            id="audit-actor"
            labelText="작업자 이메일"
            placeholder="부분 일치"
            value={actor}
            onChange={(e) => resetPage(setActor)(e.target.value)}
          />
          <Select id="audit-action" labelText="액션" value={action} onChange={(e) => resetPage(setAction)(e.target.value)}>
            <SelectItem value="" text="모든 액션" />
            {AUDIT_ACTIONS.map((a) => (
              <SelectItem key={a} value={a} text={`${AUDIT_ACTION_LABELS[a]} (${a})`} />
            ))}
          </Select>
          <TextInput
            id="audit-lease"
            labelText="lease"
            placeholder="이름 또는 id"
            value={lease}
            onChange={(e) => resetPage(setLease)(e.target.value)}
          />
          <TextInput id="audit-from" type="date" labelText="시작일" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} />
          <TextInput id="audit-to" type="date" labelText="종료일" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} />
        </div>
        {error && <InlineNotification kind="error" title="불러오지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
        {loading && !data ? (
          <DataTableSkeleton headers={HEADERS.map((header) => ({ header }))} columnCount={HEADERS.length + 1} rowCount={8} showHeader={false} showToolbar={false} />
        ) : (
          <div className="table-scroll">
            <Table size="md" aria-label="감사 로그">
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="상세 펼치기" />
                  {HEADERS.map((h) => (
                    <TableHeader key={h}>{h}</TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data?.items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={HEADERS.length + 1}>조건에 맞는 기록이 없습니다.</TableCell>
                  </TableRow>
                )}
                {data?.items.map((log) => {
                  const isOpen = expanded.has(log.id);
                  return (
                    <Fragment key={log.id}>
                      <TableExpandRow aria-label="상세 보기" isExpanded={isOpen} onExpand={() => toggle(log.id)}>
                        <TableCell className="nowrap">{formatDateTime(log.at)}</TableCell>
                        <TableCell>
                          {log.actorEmail ?? "-"}
                          <div className="cell-sub">{ACTOR_ROLE_LABELS[log.actorRole]}</div>
                        </TableCell>
                        <TableCell>
                          <Tag type={log.action.startsWith("admin.") ? "purple" : log.action.startsWith("system.") ? "cool-gray" : "blue"} size="sm">
                            {AUDIT_ACTION_LABELS[log.action] ?? log.action}
                          </Tag>
                        </TableCell>
                        <TableCell className="mono">{log.leaseName ?? (log.leaseId ? log.leaseId.slice(0, 8) : "-")}</TableCell>
                        <TableCell>{log.targetEmail ?? "-"}</TableCell>
                        <TableCell className="mono">{log.ip ?? "-"}</TableCell>
                      </TableExpandRow>
                      {isOpen && (
                        <TableExpandedRow colSpan={HEADERS.length + 1}>
                          <pre className="json-detail">{log.detail == null ? "(detail 없음)" : JSON.stringify(log.detail, null, 2)}</pre>
                        </TableExpandedRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {data && data.total > 0 && <KoPagination page={page} pageSize={data.pageSize} totalItems={data.total} onChange={setPage} />}
      </TableContainer>
    </div>
  );
}
