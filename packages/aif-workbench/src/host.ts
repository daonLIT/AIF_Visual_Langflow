/**
 * 화면을 품는 쪽(독립 웹, Langflow 포크)이 주입하는 설정.
 * 공유 코드는 호스트의 라우터·전역 store·주소 체계를 직접 가정하지 않고 이 값만 본다.
 */
export interface WorkbenchHost {
  /** 중앙 AIF API 주소 앞부분. 빈 문자열이면 같은 출처의 /api 를 쓴다(독립 웹). */
  apiBase: string;
  /** fetch 에 붙일 자격 증명 모드. 다른 출처의 중앙 API 를 쿠키로 부를 때 'include'. */
  credentials?: RequestCredentials;
  /** 샘플 사건 JSON 주소. 없으면 패키지에 든 fixtures/sample-case.json */
  sampleUrl?: string;
  /** 사이트에서 직접 분석을 시작하는 기능. Langflow 안에서는 Flow 실행이 그 역할을 한다. */
  analysis: boolean;
  /** 요청마다 붙일 헤더 (웹: 로그인 세션의 X-CSRF-Token) */
  extraHeaders?: () => Record<string, string>;
  /** 서버가 401(인증 필요)을 돌려주면 부른다 (웹: 로그인 화면으로) */
  onAuthRequired?: () => void;
}

const defaults: WorkbenchHost = {
  apiBase: '',
  analysis: true,
};

let current: WorkbenchHost = defaults;

/** 앱 시작 때 한 번 부른다. 빠진 값은 기본값을 쓴다. */
export function configureWorkbench(host: Partial<WorkbenchHost>): void {
  current = { ...defaults, ...host };
}

export function workbenchHost(): WorkbenchHost {
  return current;
}
