import {
  DataTableSkeleton,
  InlineNotification,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from "@carbon/react";
import { adminApi } from "../../api/admin";
import { formatDateTime } from "../../lib/format";
import { DRIFT_KIND_LABELS } from "../../lib/labels";
import { useAsync } from "../../lib/useAsync";

const HEADERS = ["종류", "타입", "호스트", "DB 값", "Cloudflare 값", "레코드 id"];
const OP_HEADERS = ["작업", "lease", "시작", "복구 시도", "마지막 오류"];

function proxiedText(value: boolean | null): string {
  return value ? " (프록시)" : "";
}

export function DriftTab() {
  const { data, loading, error } = useAsync(() => adminApi.drift(), []);
  const run = data?.run ?? null;

  return (
    <div className="admin-tab">
      <TableContainer
        title="드리프트"
        description="매주 Cloudflare 레코드와 DB를 비교한 최근 결과입니다. DB에만 있음·내용 다름·종료된 lease의 레코드는 DB 값으로 자동 복구하고, 남은 항목만 보여 줍니다. Cloudflare에만 있는 레코드는 자동으로 지우지 않으니 대시보드에서 직접 확인하세요."
      >
        {error && <InlineNotification kind="error" title="불러오지 못했습니다" subtitle={error} hideCloseButton lowContrast />}
        {loading && !data ? (
          <DataTableSkeleton headers={HEADERS.map((header) => ({ header }))} columnCount={HEADERS.length} rowCount={3} showHeader={false} showToolbar={false} />
        ) : !run ? (
          <InlineNotification kind="info" title="점검 기록 없음" subtitle="아직 드리프트 점검이 실행되지 않았습니다." hideCloseButton lowContrast />
        ) : (
          <>
            <div className="drift-summary">
              <span>점검 시각: {formatDateTime(run.at)}</span>
              {run.ok ? (
                <Tag type={run.driftCount > 0 ? "red" : "green"} size="sm">
                  {run.driftCount > 0 ? `불일치 ${run.driftCount}건` : "불일치 없음"}
                </Tag>
              ) : (
                <Tag type="red" size="sm">
                  점검 실패
                </Tag>
              )}
            </div>
            {run.error && (
              // ok인데 error가 있으면 참고 안내(dry-run 등), ok가 아니면 점검 실패
              <InlineNotification kind={run.ok ? "info" : "error"} title={run.ok ? "참고" : "점검 오류"} subtitle={run.error} hideCloseButton lowContrast />
            )}
            {run.repaired && (
              <InlineNotification
                kind={run.repaired.failed > 0 ? "warning" : "success"}
                title="자동 복구"
                subtitle={
                  `lease ${run.repaired.leases.length}개 복구` +
                  ` (삭제 ${run.repaired.leases.reduce((n, l) => n + l.removed, 0)}, 재생성 ${run.repaired.leases.reduce((n, l) => n + l.recreated, 0)}, 값 복원 ${run.repaired.leases.reduce((n, l) => n + l.restored, 0)})` +
                  (run.repaired.failed > 0 ? `, 실패 ${run.repaired.failed}건 (서버 로그 확인)` : "")
                }
                hideCloseButton
                lowContrast
              />
            )}
            {run.items.length > 0 && (
              <div className="table-scroll">
                <Table size="md" aria-label="드리프트 항목">
                  <TableHead>
                    <TableRow>
                      {HEADERS.map((h) => (
                        <TableHeader key={h}>{h}</TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {run.items.map((item, i) => {
                      const kind = DRIFT_KIND_LABELS[item.kind];
                      return (
                        <TableRow key={`${item.cfRecordId ?? item.recordId ?? i}`}>
                          <TableCell>
                            <Tag type={kind.tag} size="sm">
                              {kind.text}
                            </Tag>
                          </TableCell>
                          <TableCell>{item.type}</TableCell>
                          <TableCell className="mono">{item.host}</TableCell>
                          <TableCell className="mono">
                            {item.dbContent ?? "-"}
                            {proxiedText(item.dbProxied)}
                          </TableCell>
                          <TableCell className="mono">
                            {item.cfContent ?? "-"}
                            {proxiedText(item.cfProxied)}
                          </TableCell>
                          <TableCell className="mono">
                            {item.cfRecordId && <div>CF: {item.cfRecordId}</div>}
                            {item.recordId && <div className="cell-sub">DB: {item.recordId}</div>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </TableContainer>

      {data && data.pendingOps.length > 0 && (
        <TableContainer
          title="끝나지 않은 DNS 작업"
          description="중간에 실패했거나 끊긴 작업입니다. 매시 cron이 DB 값으로 맞춥니다. 복구 시도가 5번을 넘으면 더 시도하지 않으니 오류를 확인하세요."
        >
          <div className="table-scroll">
            <Table size="md" aria-label="끝나지 않은 DNS 작업">
              <TableHead>
                <TableRow>
                  {OP_HEADERS.map((h) => (
                    <TableHeader key={h}>{h}</TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.pendingOps.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell>{op.kind}</TableCell>
                    <TableCell className="mono">{op.leaseId}</TableCell>
                    <TableCell className="nowrap">{formatDateTime(op.startedAt)}</TableCell>
                    <TableCell>{op.attempts}</TableCell>
                    <TableCell>{op.lastError ?? "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TableContainer>
      )}
    </div>
  );
}
