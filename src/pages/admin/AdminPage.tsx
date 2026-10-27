import { Column, Grid, Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { useSearchParams } from "react-router-dom";
import { AuditLogsTab } from "./AuditLogsTab";
import { DriftTab } from "./DriftTab";
import { LeasesTab } from "./LeasesTab";
import { UsersTab } from "./UsersTab";

const TABS = [
  { key: "leases", label: "전체 임대", Component: LeasesTab },
  { key: "users", label: "사용자", Component: UsersTab },
  { key: "audit", label: "감사 로그", Component: AuditLogsTab },
  { key: "drift", label: "드리프트", Component: DriftTab },
] as const;

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const selected = Math.max(0, TABS.findIndex((t) => t.key === params.get("tab")));

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <h1 className="cds--type-heading-05 page-title">관리</h1>
        <Tabs
          selectedIndex={selected}
          onChange={({ selectedIndex }) => setParams({ tab: TABS[selectedIndex]?.key ?? "leases" }, { replace: true })}
        >
          <TabList aria-label="관리 메뉴" contained>
            {TABS.map((t) => (
              <Tab key={t.key}>{t.label}</Tab>
            ))}
          </TabList>
          <TabPanels>
            {TABS.map((t, i) => (
              <TabPanel key={t.key} className="admin-panel">
                {/* 선택된 탭만 마운트해서 불필요한 요청을 막는다 */}
                {i === selected && <t.Component />}
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      </Column>
    </Grid>
  );
}
