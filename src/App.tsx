import { Content, Loading, Theme } from "@carbon/react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import { LoginPage } from "./pages/Login";
import { MyLeasesPage } from "./pages/MyLeases";
import { useSession } from "./session";

// 첫 화면(로그인, 내 목록) 외에는 들어갈 때 불러온다. 관리 화면은 일반 회원에게 필요 없다.
const NewLeasePage = lazy(() => import("./pages/NewLease").then((m) => ({ default: m.NewLeasePage })));
const LeaseDetailPage = lazy(() => import("./pages/LeaseDetail").then((m) => ({ default: m.LeaseDetailPage })));
const AdminPage = lazy(() => import("./pages/admin/AdminPage").then((m) => ({ default: m.AdminPage })));

function usePrefersDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return dark;
}

function RequireUser({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (!me) return <Navigate to="/login" replace />;
  if (!me.isAdmin) return <Navigate to="/" replace />;
  return children;
}

export function App() {
  const dark = usePrefersDark();
  const { loading } = useSession();

  return (
    <Theme theme={dark ? "g100" : "g10"} className="app-root">
      <AppHeader />
      <Content id="main-content" className="app-content">
        {loading ? (
          <Loading description="불러오는 중" withOverlay={false} />
        ) : (
          <Suspense fallback={<Loading description="불러오는 중" withOverlay={false} />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/"
                element={
                  <RequireUser>
                    <MyLeasesPage />
                  </RequireUser>
                }
              />
              <Route
                path="/new"
                element={
                  <RequireUser>
                    <NewLeasePage />
                  </RequireUser>
                }
              />
              <Route
                path="/leases/:id"
                element={
                  <RequireUser>
                    <LeaseDetailPage />
                  </RequireUser>
                }
              />
              <Route
                path="/admin"
                element={
                  <RequireAdmin>
                    <AdminPage />
                  </RequireAdmin>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        )}
      </Content>
    </Theme>
  );
}
