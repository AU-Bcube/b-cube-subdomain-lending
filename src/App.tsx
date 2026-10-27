import { Content, Loading, Theme } from "@carbon/react";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import { LoginPage } from "./pages/Login";
import { LeaseDetailPage } from "./pages/LeaseDetail";
import { MyLeasesPage } from "./pages/MyLeases";
import { NewLeasePage } from "./pages/NewLease";
import { useSession } from "./session";

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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </Content>
    </Theme>
  );
}
