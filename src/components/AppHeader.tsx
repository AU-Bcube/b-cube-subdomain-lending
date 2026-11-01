import {
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderMenuItem,
  HeaderName,
  HeaderNavigation,
  HeaderSideNavItems,
  SideNav,
  SideNavItems,
  SkipToContent,
  Tag,
} from "@carbon/react";
import { Logout } from "@carbon/icons-react";
import { useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../session";
import { useToast } from "./Toasts";
import { WithdrawModal } from "./WithdrawModal";

export function AppHeader() {
  const { me, dev, logout, withdraw } = useSession();
  const notify = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [sideNavOpen, setSideNavOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  const navItems = me
    ? [
        { to: "/", label: "내 서브도메인", active: location.pathname === "/" || location.pathname.startsWith("/leases") || location.pathname === "/new" },
        ...(me.isAdmin ? [{ to: "/admin", label: "관리", active: location.pathname.startsWith("/admin") }] : []),
      ]
    : [];

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const openWithdraw = (e: MouseEvent) => {
    e.preventDefault();
    setSideNavOpen(false);
    setWithdrawing(true);
  };

  return (
    <Header aria-label="B-CUBE Domain">
      <SkipToContent href="#main-content">본문으로 건너뛰기</SkipToContent>
      {navItems.length > 0 && (
        <HeaderMenuButton
          aria-label={sideNavOpen ? "메뉴 닫기" : "메뉴 열기"}
          isActive={sideNavOpen}
          aria-expanded={sideNavOpen}
          onClick={() => setSideNavOpen((v) => !v)}
        />
      )}
      <HeaderName as={Link} to="/" prefix="">
        B-CUBE Domain
      </HeaderName>
      {dev && (
        <div className="header-tags">
          <Tag type="magenta" size="sm">
            DEV
          </Tag>
          {dev.dnsDryRun && (
            <Tag type="cyan" size="sm">
              DRY-RUN
            </Tag>
          )}
        </div>
      )}
      {navItems.length > 0 && (
        <HeaderNavigation aria-label="주 메뉴">
          {navItems.map((item) => (
            <HeaderMenuItem key={item.to} as={Link} to={item.to} isActive={item.active}>
              {item.label}
            </HeaderMenuItem>
          ))}
          {me?.consentUrl && (
            <HeaderMenuItem href={me.consentUrl} target="_blank" rel="noreferrer">
              B-CUBE 통합 로그인 동의 관리
            </HeaderMenuItem>
          )}
          <HeaderMenuItem href="#" onClick={openWithdraw}>
            회원 탈퇴
          </HeaderMenuItem>
        </HeaderNavigation>
      )}
      {navItems.length > 0 && (
        <SideNav aria-label="주 메뉴" expanded={sideNavOpen} isPersistent={false} onOverlayClick={() => setSideNavOpen(false)}>
          <SideNavItems>
            <HeaderSideNavItems>
              {navItems.map((item) => (
                <HeaderMenuItem key={item.to} as={Link} to={item.to} isActive={item.active} onClick={() => setSideNavOpen(false)}>
                  {item.label}
                </HeaderMenuItem>
              ))}
              {me?.consentUrl && (
                <HeaderMenuItem href={me.consentUrl} target="_blank" rel="noreferrer" onClick={() => setSideNavOpen(false)}>
                  B-CUBE 통합 로그인 동의 관리
                </HeaderMenuItem>
              )}
              <HeaderMenuItem href="#" onClick={openWithdraw}>
                회원 탈퇴
              </HeaderMenuItem>
            </HeaderSideNavItems>
          </SideNavItems>
        </SideNav>
      )}
      {me && (
        <HeaderGlobalBar>
          <HeaderGlobalAction aria-label="로그아웃" tooltipAlignment="end" onClick={onLogout}>
            <Logout size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      )}
      {me && (
        <WithdrawModal
          open={withdrawing}
          email={me.email}
          liveLeases={me.limits.used}
          onClose={() => setWithdrawing(false)}
          onConfirm={async () => {
            await withdraw(me.email);
            setWithdrawing(false);
            notify("success", "탈퇴했습니다", "회원 정보를 삭제했습니다.");
            navigate("/login", { replace: true });
          }}
        />
      )}
    </Header>
  );
}
