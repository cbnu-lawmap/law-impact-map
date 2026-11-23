/*
 * 빼곡 화면 설정 (배포할 때 .github/workflows/pages.yml 이 키 자리를 채운다)
 *
 * supabaseAnonKey 는 Supabase 의 공개(anon/publishable) 키다. 모든 표에 RLS 를 켜 두어 이 키로는
 * 검토 진행 기록을 읽기만 할 수 있다 (쓰기는 서버 /api/progress 만). 서비스 키(service_role)는 절대 여기 넣지 않는다.
 * 키 자리가 채워지지 않았으면(밑줄 두 개로 시작하는 자리 표시 그대로) 클라우드 기능을 끄고 지금처럼 이 브라우저에만 저장한다.
 */
window.PPAEGOK_CONFIG = {
  supabaseUrl: "https://bfwgwdcfdydwyiysrflm.supabase.co",
  supabaseAnonKey: "__SUPABASE_ANON_KEY__",
};
