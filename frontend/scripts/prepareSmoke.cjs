// tsc 가 .tmp-smoke 에 CommonJS 로 컴파일한 스모크 테스트를 node 로 돌릴 수 있게 준비한다.
// - package.json: 상위 frontend 의 "type": "module" 을 끊는다.
// - node_modules/@aif/workbench: '@aif/workbench/<경로>' import 를 컴파일된 패키지 소스로 잇는다.
const fs = require('node:fs');
const path = require('node:path');

const out = path.resolve(__dirname, '../.tmp-smoke');
fs.writeFileSync(path.join(out, 'package.json'), '{"type":"commonjs"}');
const link = path.join(out, 'node_modules/@aif/workbench');
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(path.join(out, 'packages/aif-workbench/src'), link, 'junction');
