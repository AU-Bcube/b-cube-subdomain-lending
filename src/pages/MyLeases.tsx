import {
  ActionableNotification,
  Button,
  Column,
  DataTableSkeleton,
  Grid,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  Stack,
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
  Tile,
  Tooltip,
} from "@carbon/react";
import { Add } from "@carbon/icons-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { LeaseItem } from "../../shared/schemas";
import { leasesApi } from "../api/leases";
import { ReleaseModal } from "../components/ReleaseModal";
import { useToast } from "../components/Toasts";
import { daysUntil, formatDate, formatDateTime } from "../lib/format";
import { LEASE_STATUS_LABELS, STATUS_REASON_LABELS, TARGET_KIND_LABELS } from "../lib/labels";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../session";

const HEADERS = ["이름", "연결 대상", "상태", "만료일", "마지막 헬스체크", "작업"];

function targetSummary(lease: LeaseItem): string {
  const main = lease.records.filter((r) => r.type !== "TXT");
  if (lease.targetKind === "ip") return main.map((r) => r.content).join(", ");
  return main[0]?.content ?? "-";
}

export function MyLeasesPage() {
  const { me, refresh } = useSession();
  const notify = useToast();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsync(() => leasesApi.list(), []);
  const [releasing, setReleasing] = useState<LeaseItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!me) return null;
  const limitReached = me.limits.used >= me.limits.max;
  const items = data?.items ?? [];
  const expiring = items.filter((l) => l.status === "active" && l.renewable);
  const suspended = items.filter((l) => l.status === "suspended");

  const afterChange = async () => {
    reload();
    await refresh();
  };

  const renew = async (lease: LeaseItem) => {
    setBusyId(lease.id);
    try {
      const r = await leasesApi.renew(lease.id);
      notify("success", "연장했습니다", `${lease.fqdn} — ${formatDate(r.expiresAt)}까지`);
      await afterChange();
    } catch (err) {
      notify("error", "연장하지 못했습니다", err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const recheck = async (lease: LeaseItem) => {
    setBusyId(lease.id);
    try {
      const r = await leasesApi.recheck(lease.id);
      if (r.reactivated) notify("success", "다시 활성화했습니다", `${lease.fqdn}: ${r.detail}`);
      else if (r.ok) notify("success", "정상입니다", r.detail);
      else notify("warning", "아직 응답이 없습니다", r.detail);
      await afterChange();
    } catch (err) {
      notify("error", "재확인하지 못했습니다", err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const newButton = (
    <Button renderIcon={Add} disabled={limitReached} onClick={() => navigate("/new")}>
      새 서브도메인
    </Button>
  );
  const limitText = `1인당 최대 ${me.limits.max}개까지 사용할 수 있습니다. 사용하지 않는 서브도메인을 반납하면 새로 만들 수 있습니다.`;

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <Stack gap={5}>
          <h1 className="cds--type-heading-05">내 서브도메인</h1>

          {expiring.map((lease) => (
            <ActionableNotification
              key={`exp-${lease.id}`}
              kind="warning"
              title="만료 임박"
              subtitle={`${lease.fqdn}이(가) ${formatDate(lease.expiresAt)}에 만료됩니다 (${daysUntil(lease.expiresAt)}일 남음). 만료되면 DNS 레코드가 삭제됩니다.`}
              actionButtonLabel="연장"
              onActionButtonClick={() => void renew(lease)}
              hideCloseButton
              lowContrast
              inline
            />
          ))}
          {suspended.map((lease) => (
            <ActionableNotification
              key={`sus-${lease.id}`}
              kind="error"
              title="일시 중지됨"
              subtitle={`${lease.fqdn}의 연결 대상이 계속 응답하지 않아 DNS 레코드를 내렸습니다. 서버나 배포를 확인한 뒤 재확인을 누르면 다시 연결됩니다.`}
              actionButtonLabel="재확인"
              onActionButtonClick={() => void recheck(lease)}
              hideCloseButton
              lowContrast
              inline
            />
          ))}

          {error && <InlineNotification kind="error" title="불러오지 못했습니다" subtitle={error} hideCloseButton lowContrast />}

          {loading && !data ? (
            <DataTableSkeleton headers={HEADERS.map((header) => ({ header }))} columnCount={HEADERS.length} rowCount={3} showHeader={false} showToolbar={false} />
          ) : items.length === 0 && !error ? (
            <Tile className="empty-tile">
              <Stack gap={5}>
                <h2 className="cds--type-heading-03">아직 서브도메인이 없습니다</h2>
                <p>
                  <span className="mono">이름.{me.zone}</span> 형태의 주소를 만들어 Vercel 프로젝트나 서버(AWS 등)에 연결할 수 있습니다.
                </p>
                <div>{newButton}</div>
              </Stack>
            </Tile>
          ) : (
            <TableContainer
              title={`사용 중 ${me.limits.used} / ${me.limits.max}`}
              description="이름을 누르면 레코드 편집, 헬스 상태, 변경 이력을 볼 수 있습니다."
            >
              <TableToolbar aria-label="내 서브도메인 도구">
                <TableToolbarContent>
                  {limitReached ? (
                    <Tooltip label={limitText} align="bottom-right">
                      <span className="tooltip-trigger" tabIndex={0}>
                        {newButton}
                      </span>
                    </Tooltip>
                  ) : (
                    newButton
                  )}
                </TableToolbarContent>
              </TableToolbar>
              {limitReached && <p className="limit-note cds--type-helper-text-01">{limitText}</p>}
              <div className="table-scroll">
                <Table size="md" aria-label="내 서브도메인 목록">
                  <TableHead>
                    <TableRow>
                      {HEADERS.map((h) => (
                        <TableHeader key={h}>{h}</TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {items.map((lease) => {
                      const st = LEASE_STATUS_LABELS[lease.status];
                      const live = lease.status === "active" || lease.status === "suspended";
                      return (
                        <TableRow key={lease.id}>
                          <TableCell>
                            <Link to={`/leases/${lease.id}`} className="cds--link mono">
                              {lease.fqdn}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <div>{TARGET_KIND_LABELS[lease.targetKind]}</div>
                            <div className="cell-sub mono">{targetSummary(lease)}</div>
                          </TableCell>
                          <TableCell>
                            <Tag type={st.tag} size="sm">
                              {st.text}
                            </Tag>
                            {lease.statusReason && <div className="cell-sub">{STATUS_REASON_LABELS[lease.statusReason] ?? lease.statusReason}</div>}
                          </TableCell>
                          <TableCell className="nowrap">{live ? formatDate(lease.expiresAt) : `종료 ${formatDate(lease.endedAt)}`}</TableCell>
                          <TableCell>
                            {lease.lastHealthCheckAt ? (
                              <>
                                <div className="nowrap">{formatDateTime(lease.lastHealthCheckAt)}</div>
                                <div className="cell-sub">{lease.lastHealthDetail}</div>
                              </>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell>
                            {live && (
                              <OverflowMenu aria-label={`${lease.fqdn} 작업`} flipped size="sm" disabled={busyId === lease.id}>
                                <OverflowMenuItem itemText="편집" disabled={lease.status !== "active"} onClick={() => navigate(`/leases/${lease.id}?edit=1`)} />
                                <OverflowMenuItem itemText="연장" disabled={!lease.renewable} onClick={() => void renew(lease)} />
                                <OverflowMenuItem itemText="재확인" onClick={() => void recheck(lease)} />
                                <OverflowMenuItem itemText="반납" isDelete hasDivider onClick={() => setReleasing(lease)} />
                              </OverflowMenu>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </TableContainer>
          )}
        </Stack>
      </Column>

      <ReleaseModal
        open={releasing !== null}
        name={releasing?.name ?? ""}
        fqdn={releasing?.fqdn ?? ""}
        onClose={() => setReleasing(null)}
        onConfirm={async () => {
          if (!releasing) return;
          await leasesApi.release(releasing.id);
          notify("success", "반납했습니다", releasing.fqdn);
          await afterChange();
        }}
      />
    </Grid>
  );
}
