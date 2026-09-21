// 호스트가 쓰는 진입점. 세부 모듈은 '@aif/workbench/<경로>' 로 직접 가져올 수 있다.
import './workbench.css';

export { AifWorkbench, ErrorToast, type AifWorkbenchProps } from './AifWorkbench';
export { configureWorkbench, workbenchHost, type WorkbenchHost } from './host';
export { LanguageToggle } from './components/Layout/LanguageToggle';
