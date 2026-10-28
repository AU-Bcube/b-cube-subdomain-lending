import { ListItem, OrderedList, Tile } from "@carbon/react";
import type { TargetKind } from "../../shared/rules";

/** 생성 직후와 상세 화면에서 보여주는 대상별 연결 가이드 */
export function ConnectionGuide({ kind, fqdn }: { kind: TargetKind; fqdn: string }) {
  return (
    <Tile className="guide-tile">
      <h3 className="cds--type-heading-02">연결 가이드</h3>
      {kind === "vercel" && (
        <OrderedList>
          <ListItem>
            Vercel 프로젝트 → <strong>Settings → Domains</strong>에서 <code className="mono">{fqdn}</code>을 추가합니다.
          </ListItem>
          <ListItem>
            Vercel이 다른 CNAME 값(예: <code className="mono">xxxx.vercel-dns-017.com</code>)을 안내하면 이 화면의 편집에서 CNAME 값을 바꿉니다.
          </ListItem>
          <ListItem>
            "Verification Needed"가 뜨면 안내된 <code className="mono">_vercel</code> TXT 값을 편집에서 TXT 레코드로 추가합니다.
          </ListItem>
          <ListItem>DNS 반영에는 보통 몇 분이 걸립니다. 레코드는 Cloudflare 프록시로 등록되며, 방문자 쪽 HTTPS는 Cloudflare가 처리합니다.</ListItem>
        </OrderedList>
      )}
      {kind === "ip" && (
        <OrderedList>
          <ListItem>
            서버(AWS 등)의 보안 그룹·방화벽에서 <strong>80, 443 포트</strong>를 엽니다. 헬스체크가 이 포트로 연결을 확인합니다.
          </ListItem>
          <ListItem>
            웹 서버(nginx 등)에 <code className="mono">{fqdn}</code>을 server_name으로 등록합니다.
          </ListItem>
          <ListItem>
            레코드는 Cloudflare 프록시로 등록되므로 방문자 쪽 HTTPS는 Cloudflare가 처리합니다. 서버 쪽 인증서가 필요하면 DNS-01 방식으로 <code className="mono">_acme-challenge.{fqdn}</code> TXT를 편집에서 추가합니다.
          </ListItem>
        </OrderedList>
      )}
      {kind === "cname" && (
        <OrderedList>
          <ListItem>
            연결할 서비스(Netlify, GitHub Pages 등)의 커스텀 도메인 설정에 <code className="mono">{fqdn}</code>을 추가합니다.
          </ListItem>
          <ListItem>서비스가 안내한 CNAME 대상과 이 화면의 CNAME 값이 같은지 확인합니다.</ListItem>
          <ListItem>
            서비스가 도메인 소유 확인으로 <code className="mono">_acme-challenge</code> TXT를 요구하면 편집에서 추가합니다.
          </ListItem>
        </OrderedList>
      )}
      <p className="cds--type-helper-text-01 guide-note">
        연결 대상이 응답하지 않는 상태가 계속되면(헬스체크 연속 실패) 탈취 방지를 위해 DNS 레코드가 일시 중지됩니다.
      </p>
    </Tile>
  );
}
