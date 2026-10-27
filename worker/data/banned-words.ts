/**
 * 금칙어 (SPEC §7.1). 이름에 부분 문자열로 포함되면 거부한다.
 * 욕설과 사칭성 단어를 소문자로 적는다. 목록은 관리자가 코드로 수정한다.
 */
export const BANNED_WORDS: readonly string[] = [
  // 사칭: 포털, 메신저, 금융, 결제
  "kakao", "naver", "daum", "google", "gmail", "apple", "icloud", "microsoft", "outlook",
  "bank", "paypal", "toss", "coupang", "samsung",
  "ajou-portal", "ajouportal",
  // 욕설
  "fuck", "shit", "bitch", "sibal", "ssibal", "shibal", "byungsin", "gaesaeki",
];
